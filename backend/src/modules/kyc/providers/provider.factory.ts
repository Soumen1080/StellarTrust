import { config } from "../../../config/index.js";
import type { KycProvider } from "./kyc-provider.js";
import { SandboxKycProvider } from "./sandbox.provider.js";

export function createKycProvider(): KycProvider {
  switch (config.KYC_PROVIDER) {
    case "sandbox":
      return new SandboxKycProvider();
  }
}
