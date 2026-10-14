export class InvalidLauncherError extends Error {}

export class StackConfigError extends Error {}

export class ProcessExitedError extends Error {}

/** The GPU lease was broken by another client (`stack gpu release --force`) or released already. */
export class GpuLeaseLostError extends Error {}
