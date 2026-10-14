export interface Interval { start: number; end: number }

export interface WindowEvent { start: number; end: number; app: string; title: string }
export interface AfkEvent { start: number; end: number; afk: boolean }
export interface WebEvent { start: number; end: number; url: string; title: string; audible?: boolean }
export interface MediaEvent { start: number; end: number; player: string; title: string; artist?: string; album?: string }
export interface CommitEvent { ts: number; repo: string; message: string; author?: string }
export interface PromptEvent { ts: number; project: string; text: string }

export interface BlockSignals {
  start: number;
  end: number;
  awAvailable: boolean;
  window: WindowEvent[];
  afk: AfkEvent[];
  web: WebEvent[];
  media: MediaEvent[];
  commits: CommitEvent[];
  prompts: PromptEvent[];
}

export interface SenseSources {
  collect(start: number, end: number): Promise<BlockSignals>;
}

export interface ActivityCard {
  start: number;
  end: number;
  activeMinutes: number;
  afkMinutes: number;
  empty: boolean;
  paused: boolean;
  summary: string;
  card: string | null;
}