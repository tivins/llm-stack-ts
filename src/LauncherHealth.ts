export interface LauncherHealth {
  readonly url: string;
  readonly timeoutSeconds: number;
  readonly intervalMs: number;
  /** Exact status to expect; any 2xx is accepted when unset. */
  readonly expectedStatus?: number;
}
