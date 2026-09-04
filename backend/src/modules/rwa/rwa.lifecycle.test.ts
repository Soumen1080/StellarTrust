/**
 * RWA lifecycle transitions (plane.md §1.4).
 *
 * The job's whole purpose is to make the passage of time change state, so every
 * test pins the clock rather than waiting: the injected `now` is what makes
 * "ninety-one days later" a synchronous assertion instead of a timer.
 */
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { StaticWalletAddressResolver } from "../identity/wallet.resolver.js";
import { PrefundedLedgerService } from "../ledger/ledger.test-fixtures.js";
import { EventBus } from "../events/event.bus.js";
import { InMemoryEventRepository } from "../events/event.repository.js";
import { DomainEventType, EventEntity } from "../events/event.types.js";
import { DeterministicRwaGateway } from "./rwa.gateway.js";
import { RwaLifecycleJob } from "./rwa.lifecycle.job.js";
import { InMemoryRwaRepository } from "./rwa.repository.js";
import { RwaService, type RwaActor } from "./rwa.service.js";
import { TokenizationStatus } from "./rwa.types.js";
import { createVerifiedAsset } from "./rwa.test-fixtures.js";

const ISSUER_ADDRESS = "GBUV3T3YDFD232LUXGADFZV2XCMNEHXBMVTQPBD7DKHTP4Q6ZLNOSMEX";
const INVESTOR1_ADDRESS = "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5";

const issuer: RwaActor = { userId: "issuer-1", roles: ["user"] };
const investor: RwaActor = { userId: "investor-1", roles: ["user"] };
const compliance: RwaActor = { userId: "officer-1", roles: ["compliance"] };

const DAY = 86_400_000;
/** Maturity 90 days out, matching the fixture's "90-day receivable". */
const MATURITY = new Date(Date.now() + 90 * DAY);

function setup(graceDays = 30, now: () => Date = () => new Date()) {
  const repository = new InMemoryRwaRepository();
  const audit = new InMemoryAuditRepository();
  const ledger = new PrefundedLedgerService();
  const service = new RwaService(
    repository,
    new DeterministicRwaGateway(),
    audit,
    ledger,
    new StaticWalletAddressResolver(new Map([["issuer-1", ISSUER_ADDRESS]])),
  );
  const eventRepository = new InMemoryEventRepository();
  const bus = new EventBus(eventRepository, undefined, { sleep: async () => {} });
  const job = new RwaLifecycleJob(
    repository,
    audit,
    60_000,
    graceDays,
    undefined,
    undefined,
    now,
    bus,
  );
  return { repository, audit, ledger, service, job, eventRepository };
}

/** A fully-subscribed position, which is what `Funded` means. */
async function fundedPosition(service: RwaService) {
  const asset = await createVerifiedAsset(service, issuer.userId);
  const tokenization = await service.createTokenization(issuer.userId, {
    assetId: asset.id,
    totalUnits: "1000",
    faceValueAmount: "1000000",
    faceValueCurrency: "USDC",
    advanceRateBps: 8_000,
    discountRateBps: 400,
    platformFeeBps: 100,
    maturityDate: MATURITY.toISOString(),
  });
  const deployed = await service.deployTokenization(tokenization.id, issuer);
  // Buying every unit is what flips the status to `Funded`.
  await service.purchaseUnits(deployed.id, investor, {
    units: "1000",
    holderAddress: INVESTOR1_ADDRESS,
  });
  return deployed;
}

describe("RWA lifecycle job", () => {
  it("leaves a funded position alone before maturity", async () => {
    const { service, repository, job } = setup(30, () => new Date());
    const tokenization = await fundedPosition(service);

    const report = await job.run();

    expect(report.matured).toBe(0);
    expect(report.defaulted).toBe(0);
    const after = await repository.findTokenization(tokenization.id);
    expect(after?.status).toBe(TokenizationStatus.Funded);
  });

  it("moves a funded position to matured once maturity passes", async () => {
    let clock = new Date();
    const { service, repository, job } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);

    clock = new Date(MATURITY.getTime() + DAY);
    const report = await job.run();

    expect(report.matured).toBe(1);
    const after = await repository.findTokenization(tokenization.id);
    expect(after?.status).toBe(TokenizationStatus.Matured);
  });

  it("holds a matured position inside the grace window", async () => {
    let clock = new Date();
    const { service, repository, job } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);

    clock = new Date(MATURITY.getTime() + DAY);
    await job.run(); // → matured
    clock = new Date(MATURITY.getTime() + 29 * DAY);
    const report = await job.run();

    expect(report.defaulted).toBe(0);
    const after = await repository.findTokenization(tokenization.id);
    expect(after?.status).toBe(TokenizationStatus.Matured);
  });

  it("defaults a matured position past the grace window", async () => {
    let clock = new Date();
    const { service, repository, audit, job } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);

    clock = new Date(MATURITY.getTime() + DAY);
    await job.run(); // → matured
    clock = new Date(MATURITY.getTime() + 31 * DAY);
    const report = await job.run();

    expect(report.defaulted).toBe(1);
    expect(report.defaultedIds).toContain(tokenization.id);
    const after = await repository.findTokenization(tokenization.id);
    expect(after?.status).toBe(TokenizationStatus.Defaulted);

    // The transition is auditable and attributed to the clock, not a person.
    const events = await audit.listForEntity("tokenization", tokenization.id);
    const defaulted = events.find(
      (e) => e.action === "rwa.tokenization_defaulted",
    );
    expect(defaulted?.actor).toBe("system:rwa-lifecycle");
  });

  it("is idempotent: a second sweep re-transitions nothing", async () => {
    let clock = new Date();
    const { service, job } = setup(30, () => clock);
    await fundedPosition(service);

    clock = new Date(MATURITY.getTime() + 31 * DAY);
    await job.run(); // → matured
    await job.run(); // → defaulted
    const third = await job.run();

    expect(third.matured).toBe(0);
    expect(third.defaulted).toBe(0);
  });

  it("never matures a position whose collection already arrived", async () => {
    let clock = new Date();
    const { service, repository, job } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);

    // The debtor pays; the payout closes the position as repaid.
    await service.distributePayout(
      tokenization.id,
      "order-1",
      "release",
      1_000_000n,
      "USDC",
      { userId: "system", roles: ["system"] },
    );

    clock = new Date(MATURITY.getTime() + 31 * DAY);
    const report = await job.run();

    expect(report.matured).toBe(0);
    expect(report.defaulted).toBe(0);
    const after = await repository.findTokenization(tokenization.id);
    expect(after?.status).toBe(TokenizationStatus.Repaid);
  });
});

describe("RWA write-off", () => {
  it("refuses to write off a position that has not defaulted", async () => {
    const { service } = setup();
    const tokenization = await fundedPosition(service);

    await expect(
      service.writeOffTokenization(tokenization.id, 0n, compliance),
    ).rejects.toThrow(/defaulted/i);
  });

  it("refuses a write-off from someone without the compliance role", async () => {
    let clock = new Date();
    const { service, job } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);
    clock = new Date(MATURITY.getTime() + 31 * DAY);
    await job.run();
    await job.run();

    await expect(
      service.writeOffTokenization(tokenization.id, 0n, investor),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("distributes recovery pro-rata and closes the position", async () => {
    let clock = new Date();
    const { service, repository, ledger, job } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);
    clock = new Date(MATURITY.getTime() + 31 * DAY);
    await job.run(); // → matured
    await job.run(); // → defaulted

    // Collections recovered a quarter of the face value.
    const updated = await service.writeOffTokenization(
      tokenization.id,
      250_000n,
      compliance,
    );

    expect(updated.status).toBe(TokenizationStatus.WrittenOff);

    // The recovery posts to the ledger in full — no fee is taken ahead of
    // investors on a written-off position.
    const posted = await ledger.getByReference(
      `rwa-writeoff:${tokenization.id}`,
    );
    expect(posted).toBeDefined();
    const credited = posted!.entries
      .filter((e) => e.direction === "credit")
      .reduce((sum, e) => sum + BigInt(e.amount), 0n);
    expect(credited).toBe(250_000n);

    const after = await repository.findTokenization(tokenization.id);
    expect(after?.status).toBe(TokenizationStatus.WrittenOff);
  });

  it("closes a position with no recovery at all without posting to the ledger", async () => {
    let clock = new Date();
    const { service, ledger, job } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);
    clock = new Date(MATURITY.getTime() + 31 * DAY);
    await job.run();
    await job.run();

    const updated = await service.writeOffTokenization(
      tokenization.id,
      0n,
      compliance,
    );

    expect(updated.status).toBe(TokenizationStatus.WrittenOff);
    // A zero-amount ledger entry is rejected by the schema, and there is
    // genuinely nothing to record: the loss is total.
    expect(
      await ledger.getByReference(`rwa-writeoff:${tokenization.id}`),
    ).toBeUndefined();
  });
});

/**
 * The lifecycle on the event spine (plane.md §1.4 × §2.3).
 *
 * Maturity and default were the two state changes in the platform that happened
 * silently: every other domain announced its transitions, while a position
 * quietly went from funded to defaulted with only a row and an audit line to
 * show for it. `tokenization.matured` and `tokenization.defaulted` were declared
 * in the event vocabulary from the start and published by nothing.
 */
describe("RWA lifecycle events", () => {
  it("announces maturity on the spine", async () => {
    let clock = new Date();
    const { service, job, eventRepository } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);

    clock = new Date(MATURITY.getTime() + DAY);
    await job.run();

    const events = await eventRepository.listForEntity(
      EventEntity.Tokenization,
      tokenization.id,
    );
    const matured = events.find(
      (e) => e.eventType === DomainEventType.TokenizationMatured,
    );
    expect(matured).toBeDefined();
    // A date decided this, not a person.
    expect(matured?.actor).toBe("system:rwa-lifecycle");
    expect(matured?.payload.previousStatus).toBe(TokenizationStatus.Funded);
  });

  it("announces default with the grace window that was applied", async () => {
    let clock = new Date();
    const { service, job, eventRepository } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);

    clock = new Date(MATURITY.getTime() + 31 * DAY);
    await job.run(); // → matured
    await job.run(); // → defaulted

    const events = await eventRepository.listForEntity(
      EventEntity.Tokenization,
      tokenization.id,
    );
    const defaulted = events.find(
      (e) => e.eventType === DomainEventType.TokenizationDefaulted,
    );
    expect(defaulted).toBeDefined();
    expect(defaulted?.payload.graceDays).toBe(30);
    expect(defaulted?.payload.previousStatus).toBe(TokenizationStatus.Matured);
  });

  it("carries no holder identities or amounts in the payload", async () => {
    let clock = new Date();
    const { service, job, eventRepository } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);

    clock = new Date(MATURITY.getTime() + DAY);
    await job.run();

    const [event] = await eventRepository.listForEntity(
      EventEntity.Tokenization,
      tokenization.id,
    );
    // Rules.md §3: dates and opaque ids only. A subscriber needing figures
    // reads its own domain rather than trusting an event to carry them.
    const serialized = JSON.stringify(event?.payload ?? {});
    expect(serialized).not.toContain(INVESTOR1_ADDRESS);
    expect(serialized).not.toContain("1000000");
  });

  it("publishes one fact per transition however often the sweep runs", async () => {
    let clock = new Date();
    const { service, job, eventRepository } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);

    clock = new Date(MATURITY.getTime() + 31 * DAY);
    await job.run();
    await job.run();
    // Extra sweeps find nothing left to transition, so nothing further is said.
    await job.run();
    await job.run();

    const events = await eventRepository.listForEntity(
      EventEntity.Tokenization,
      tokenization.id,
    );
    expect(events).toHaveLength(2);
  });

  it("still transitions when the spine is unavailable", async () => {
    let clock = new Date();
    const { service, repository } = setup(30, () => clock);
    const tokenization = await fundedPosition(service);

    // A publisher that always throws. The status change has already committed
    // by the time it runs, so the sweep must not be derailed by it.
    const broken = new RwaLifecycleJob(
      repository,
      new InMemoryAuditRepository(),
      60_000,
      30,
      undefined,
      undefined,
      () => clock,
      {
        publish: () => Promise.reject(new Error("spine down")),
      },
    );

    clock = new Date(MATURITY.getTime() + DAY);
    const report = await broken.run();

    expect(report.matured).toBe(1);
    expect((await repository.findTokenization(tokenization.id))?.status).toBe(
      TokenizationStatus.Matured,
    );
  });
});
