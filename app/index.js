/**
 * Native entry point.
 *
 * The polyfills load before anything else: @stellar/stellar-sdk needs
 * `crypto.getRandomValues` and a WHATWG `URL`, neither of which Hermes
 * provides. Importing them here rather than inside App guarantees they are
 * installed before any module that captures them at import time.
 */
import "react-native-get-random-values";
import "react-native-url-polyfill/auto";

import { registerRootComponent } from "expo";

import App from "./src/App";

registerRootComponent(App);
