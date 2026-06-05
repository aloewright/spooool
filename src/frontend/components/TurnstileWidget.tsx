import React from 'react';
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile';

interface TurnstileWidgetProps {
  onSuccess: (token: string) => void;
  onError?: () => void;
  onExpire?: () => void;
}

export const TurnstileWidget = React.forwardRef<TurnstileInstance, TurnstileWidgetProps>(
  ({ onSuccess, onError, onExpire }, ref) => {
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;

    if (!siteKey) {
      console.warn('VITE_TURNSTILE_SITE_KEY is not set');
      return null;
    }

    return (
      <div className="flex justify-center my-4">
        <Turnstile
          ref={ref}
          siteKey={siteKey}
          onSuccess={onSuccess}
          onError={onError}
          onExpire={onExpire}
          options={{
            theme: 'auto',
          }}
        />
      </div>
    );
  }
);

TurnstileWidget.displayName = 'TurnstileWidget';
