/** true cuando el intento actual agota el máximo configurado para el job. */
export function isFinalDianAttempt(attemptsMade: number, configuredAttempts?: number): boolean {
  const parsedMax = Number(configuredAttempts);
  const maxAttempts = Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : 1;
  const previousAttempts = Number.isInteger(attemptsMade) && attemptsMade >= 0 ? attemptsMade : 0;
  return previousAttempts + 1 >= maxAttempts;
}
