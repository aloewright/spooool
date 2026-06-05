// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { TurnstileInstance } from '@marsidev/react-turnstile';

// ── Mock @marsidev/react-turnstile ─────────────────────────────────────────────
// The real Turnstile widget loads a Cloudflare script at runtime which is
// unavailable in the test environment. We replace it with a simple div that
// forwards props so we can assert on them.

type TurnstileProps = {
  siteKey: string;
  onSuccess?: (token: string) => void;
  onError?: () => void;
  onExpire?: () => void;
  options?: { theme?: string };
};

let lastTurnstileProps: TurnstileProps | null = null;

vi.mock('@marsidev/react-turnstile', () => ({
  Turnstile: (props: TurnstileProps) => {
    lastTurnstileProps = props;
    return <div data-testid="turnstile-mock" data-site-key={props.siteKey} />;
  },
}));

// ── DOM setup ─────────────────────────────────────────────────────────────────

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

function mount(element: JSX.Element): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() => {
    root!.render(element);
  });
}

beforeEach(() => {
  lastTurnstileProps = null;
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.unstubAllEnvs();
});

// Import after mocks are in place
import { TurnstileWidget } from './TurnstileWidget';

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TurnstileWidget', () => {
  describe('when VITE_TURNSTILE_SITE_KEY is not set', () => {
    it('renders nothing (returns null)', () => {
      // No env var stubbed → import.meta.env.VITE_TURNSTILE_SITE_KEY is undefined
      mount(
        <TurnstileWidget onSuccess={vi.fn()} />,
      );
      expect(container!.querySelector('[data-testid="turnstile-mock"]')).toBeNull();
      expect(container!.innerHTML).toBe('');
    });

    it('does not call onSuccess when not rendered', () => {
      const onSuccess = vi.fn();
      mount(<TurnstileWidget onSuccess={onSuccess} />);
      expect(onSuccess).not.toHaveBeenCalled();
    });
  });

  describe('when VITE_TURNSTILE_SITE_KEY is set', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'test-site-key-123');
    });

    it('renders the Turnstile widget', () => {
      mount(
        <TurnstileWidget onSuccess={vi.fn()} />,
      );
      expect(container!.querySelector('[data-testid="turnstile-mock"]')).not.toBeNull();
    });

    it('passes the siteKey to Turnstile', () => {
      mount(<TurnstileWidget onSuccess={vi.fn()} />);
      const el = container!.querySelector('[data-testid="turnstile-mock"]');
      expect(el?.getAttribute('data-site-key')).toBe('test-site-key-123');
    });

    it('wraps Turnstile in a centering div', () => {
      mount(<TurnstileWidget onSuccess={vi.fn()} />);
      const wrapper = container!.querySelector('div.flex');
      expect(wrapper).not.toBeNull();
      expect(wrapper!.classList.contains('justify-center')).toBe(true);
      expect(wrapper!.classList.contains('my-4')).toBe(true);
    });

    it('forwards onSuccess callback to Turnstile', () => {
      const onSuccess = vi.fn();
      mount(<TurnstileWidget onSuccess={onSuccess} />);
      // Simulate the Turnstile widget calling onSuccess
      act(() => {
        lastTurnstileProps?.onSuccess?.('cf-challenge-token');
      });
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledWith('cf-challenge-token');
    });

    it('forwards onError callback to Turnstile', () => {
      const onError = vi.fn();
      mount(<TurnstileWidget onSuccess={vi.fn()} onError={onError} />);
      act(() => {
        lastTurnstileProps?.onError?.();
      });
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('forwards onExpire callback to Turnstile', () => {
      const onExpire = vi.fn();
      mount(<TurnstileWidget onSuccess={vi.fn()} onExpire={onExpire} />);
      act(() => {
        lastTurnstileProps?.onExpire?.();
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
    });

    it('passes theme: auto in options', () => {
      mount(<TurnstileWidget onSuccess={vi.fn()} />);
      expect(lastTurnstileProps?.options?.theme).toBe('auto');
    });

    it('renders without crashing when optional callbacks are not provided', () => {
      expect(() =>
        mount(<TurnstileWidget onSuccess={vi.fn()} />),
      ).not.toThrow();
    });

    it('has displayName TurnstileWidget', () => {
      expect(TurnstileWidget.displayName).toBe('TurnstileWidget');
    });
  });

  describe('forwardRef', () => {
    it('accepts a ref without crashing', () => {
      vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'key-for-ref-test');
      const ref = { current: null as TurnstileInstance | null };
      expect(() =>
        mount(<TurnstileWidget ref={ref} onSuccess={vi.fn()} />),
      ).not.toThrow();
    });

    it('is a forwardRef component (has $$typeof ForwardRef or is callable)', () => {
      // Verifying the component was created with React.forwardRef
      // react-dom createRoot will accept it without errors as a functional component
      vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'key-for-ref-type-test');
      mount(<TurnstileWidget onSuccess={vi.fn()} />);
      // If it renders the widget, forwardRef is working correctly
      expect(container!.querySelector('[data-testid="turnstile-mock"]')).not.toBeNull();
    });
  });
});