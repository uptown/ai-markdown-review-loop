import type { ReviewWebviewState, WebviewToHostMessage } from '../webviewMessages';

declare global {
  interface Window {
    reviewInitialState: ReviewWebviewState;
    mermaid?: {
      initialize(config: object): void;
      render(id: string, source: string): Promise<{ svg: string; bindFunctions?: (element: Element) => void }>;
    };
  }
  function acquireVsCodeApi(): {
    postMessage(message: WebviewToHostMessage): void;
    getState(): any;
    setState(state: unknown): void;
  };
}
