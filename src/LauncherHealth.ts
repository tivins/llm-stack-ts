export interface LauncherHealth {
  readonly url: string;
  readonly timeoutSeconds: number;
  readonly intervalMs: number;
  readonly expectedStatus: number;
}
