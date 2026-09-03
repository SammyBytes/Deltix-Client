import { printInfo } from './output';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Runs an async operation with a lightweight terminal spinner while it's
 * pending, giving the user immediate visual feedback that work is in
 * progress (e.g. a slow `deltix push` over the network).
 *
 * When stdout is a TTY it renders an animated spinner on a single line,
 * overwriting it in place via carriage returns, and erases the line when
 * done so the caller's own output follows cleanly. When stdout is NOT a
 * TTY (piped, CI), it just prints a one-line status message and runs the
 * operation without any animation — no ANSI garbage in logs or scripts.
 */
export async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  if (process.stdout.isTTY !== true) {
    printInfo(`${message}...`);
    return await fn();
  }

  let i = 0;
  let erased = false;
  const write = (s: string) => process.stdout.write(s);

  const id = setInterval(() => {
    if (erased) return;
    const frame = currentFrame();
    i++;
    write(`\r\u001B[K${frame} ${message}...`);
  }, 100);

  function currentFrame(): string {
    return FRAMES[i % FRAMES.length] ?? '⠋';
  }

  const erase = () => {
    if (erased) return;
    erased = true;
    clearInterval(id);
    write('\r\u001B[K');
  };

  // Kick off the first frame immediately so the spinner shows even if the
  // operation resolves in under one interval.
  write(`\r\u001B[K${currentFrame()} ${message}...`);

  try {
    return await fn();
  } finally {
    erase();
  }
}
