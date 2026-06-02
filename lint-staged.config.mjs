export default {
  // Lint and auto-fix only the staged TS files.
  '{src,libs,test}/**/*.ts': 'eslint --fix',
  // Format all staged files regardless of type.
  '*': 'prettier --write --ignore-unknown',
}
