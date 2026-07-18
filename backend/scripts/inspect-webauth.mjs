import * as sdk from "@stellar/stellar-sdk";
console.log("WebAuth exports:", Object.keys(sdk.WebAuth ?? {}));
for (const [name, value] of Object.entries(sdk.WebAuth ?? {})) {
  if (typeof value === "function") console.log(`\n${name}:\n${value.toString().slice(0, 1200)}`);
}
