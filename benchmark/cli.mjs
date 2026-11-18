// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const usageErrors = new Set(['ERR_PARSE_ARGS_UNKNOWN_OPTION', 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
  'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL']);

export function describeCliError(error) {
  if (error?.code === 'EEXIST' && error.path) {
    return `Output already exists: ${error.path}\nChoose a new --out path; existing results are never overwritten.`;
  }
  if (error?.code === 'ENOENT' && error.path) return `File or folder not found: ${error.path}`;
  const message = error instanceof Error ? error.message : String(error);
  return usageErrors.has(error?.code) ? `${message}\nRun with --help for usage.` : message;
}

export function runCli(main) {
  return main().catch(error => { console.error(describeCliError(error)); process.exitCode = 1; });
}
