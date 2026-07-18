import { config } from "../src/config/index.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";

// eslint-disable-next-line no-console
console.log("config loaded:", config.serviceName, typeof LedgerService);
