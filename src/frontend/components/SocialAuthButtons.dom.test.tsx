// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { SocialAuthButtons } from './SocialAuthButtons';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SocialAuthButtons', () => {
  it('uses the Strand stack layout so the provider buttons have a visible gap', () => {
    const container = document.createElement('div');
    const root = ReactDOM.createRoot(container);

    act(() => root.render(<SocialAuthButtons callbackURL="/" onError={vi.fn()} />));

    const socialCard = container.querySelector('.card');
    expect(socialCard).not.toBeNull();
    expect(socialCard?.classList.contains('stack')).toBe(true);
    expect(socialCard?.classList.contains('stack-sm')).toBe(true);
    expect(socialCard?.querySelectorAll(':scope > button')).toHaveLength(2);

    const wrapper = socialCard?.parentElement;
    expect(wrapper?.classList.contains('stack')).toBe(true);
    expect(wrapper?.classList.contains('stack-sm')).toBe(true);

    act(() => root.unmount());
  });
});
