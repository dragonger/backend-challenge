/** Polls `condition` until it returns a truthy value or the timeout expires. */
export async function waitFor<T>(
  description: string,
  condition: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  timeoutMs = 30_000,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const value = await condition();

      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for: ${description}${lastError instanceof Error ? ` (last error: ${lastError.message})` : ''}`,
  );
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
