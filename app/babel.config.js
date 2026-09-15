module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          root: ["./"],
          alias: { "@": "./src" },
          extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
        },
      ],
      // Must stay last: Reanimated's worklet transform rewrites functions the
      // other plugins have already visited.
      "react-native-reanimated/plugin",
    ],
  };
};
