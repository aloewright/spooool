import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Ported from studio/apps/web/client/lib/utils.ts. The shadcn-style `cn`
// helper used by the content-hub UI primitives: clsx for conditional class
// composition, twMerge to dedupe conflicting Tailwind utilities.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
