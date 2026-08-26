export default {
  extends: ["@commitlint/config-conventional"],
  ignores: [
    (message) => message.startsWith("Merge "),
    (message) => message.startsWith("Revert "),
    (message) => message.startsWith("fixup!"),
    (message) => message.startsWith("squash!"),
  ],
};
