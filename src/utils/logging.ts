import { useToast } from "primevue/usetoast";

import { getErrorMessage, toNormalizedError } from "./errorHandling.ts";

export function useLog() {
  const toast = useToast();

  function logError(maybeError: unknown, context?: string) {
    const error = toNormalizedError(maybeError);
    console.error(context, error, error?.stack);
    const prefix = context ?? "Error";
    toast.add({
      summary: prefix,
      detail: `${getErrorMessage(error)}`,
      severity: "error",
      life: 4000,
    });
  }

  function logWarning(message: string, context?: string) {
    const prefix = context ?? "Warning";
    console.warn(prefix, message);
    toast.add({
      summary: prefix,
      detail: message,
      severity: "warn",
      life: 4000,
    });
  }

  return { logError, logWarning };
}
