/**
 * Transport tests.
 *
 * The property that matters most is negative: a mutation WITHOUT an
 * idempotency key must never be retried, because a retried payment the server
 * cannot recognize as a duplicate is a double spend. The rest of these pin the
 * behaviour that makes the app usable on a phone connection.
 */
import { ApiClientError, ApiTimeoutError, ApiUnreachableError } from "./errors";
import { apiRequest, onSessionExpired } from "./http";

const ok = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: new Map(),
  }) as unknown as Response;

const fail = (status: number, body?: unknown) =>
  ({
    ok: false,
    status,
    text: async () => JSON.stringify(body ?? {}),
    json: async () => body,
    headers: new Map(),
  }) as unknown as Response;

describe("apiRequest", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("returns the parsed body on success", async () => {
    fetchMock.mockResolvedValueOnce(ok({ value: 42 }));
    await expect(apiRequest<{ value: number }>("/x")).resolves.toEqual({
      value: 42,
    });
  });

  it("sends the bearer token and idempotency key as headers", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    await apiRequest("/x", {
      method: "POST",
      accessToken: "tok",
      idempotencyKey: "key-1",
      body: { a: 1 },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(init.headers["idempotency-key"]).toBe("key-1");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("retries a GET through a network fault", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce(ok({ ok: true }));

    await expect(apiRequest("/x")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a mutation that carries an idempotency key", async () => {
    // Safe precisely because the server collapses the repeat on the key.
    fetchMock
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce(ok({ ok: true }));

    await expect(
      apiRequest("/pay", {
        method: "POST",
        idempotencyKey: "key-1",
        body: {},
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a mutation without an idempotency key", async () => {
    // The double-spend guard. A second attempt here would be a second payment.
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));

    await expect(
      apiRequest("/pay", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(ApiUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 4xx, which will not change on a repeat", async () => {
    fetchMock.mockResolvedValue(
      fail(400, { error: { code: "validation", message: "Bad amount" } }),
    );

    await expect(apiRequest("/x")).rejects.toBeInstanceOf(ApiClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server's own error message", async () => {
    fetchMock.mockResolvedValue(
      fail(409, { error: { code: "conflict", message: "Already locked" } }),
    );

    await expect(apiRequest("/x")).rejects.toThrow("Already locked");
  });

  it("retries a 503 and succeeds on a later attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(fail(503))
      .mockResolvedValueOnce(ok({ ok: true }));

    await expect(apiRequest("/x")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("notifies listeners once the session is rejected", async () => {
    const listener = jest.fn();
    const unsubscribe = onSessionExpired(listener);
    fetchMock.mockResolvedValue(
      fail(401, { error: { code: "auth", message: "Expired" } }),
    );

    await expect(apiRequest("/x", { accessToken: "old" })).rejects.toBeInstanceOf(
      ApiClientError,
    );
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("gives up with a timeout error when the deadline passes", async () => {
    // Never settles: the AbortController is the only thing that ends it.
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    await expect(
      apiRequest("/slow", { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  it("treats an empty 204 as a success rather than a parse failure", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => "",
      headers: new Map(),
    } as unknown as Response);

    await expect(apiRequest("/x", { method: "DELETE" })).resolves.toBeUndefined();
  });
});
