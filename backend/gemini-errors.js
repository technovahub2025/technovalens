export function getHttpStatus(error) {
  const providerError = getProviderErrorDetails(error).body;
  const directStatus = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? providerError?.code);
  if (directStatus >= 400 && directStatus <= 599) return directStatus;
  const errorText = `${providerError?.status || ""} ${error?.message || ""} ${error?.code || ""}`;
  const match = errorText.match(/(?:HTTP\s*|status[:= ]+)?(400|401|403|404|408|409|413|422|429|500|501|502|503|504)\b/i);
  if (match) return Number(match[1]);
  if (error?.name === "RequestTimeoutError" || /deadline[_ ]exceeded|deadline expired|request timed? ?out|timeout|ETIMEDOUT|ECONNABORTED/i.test(errorText)) return 504;
  return null;
}

export function getProviderErrorDetails(error) {
  let body;
  try { body = JSON.parse(error?.message || ""); } catch { /* SDK/network errors may not contain a JSON body. */ }
  body = error?.response?.data || error?.error || body;
  const providerError = body?.error && typeof body.error === "object" ? body.error : body && typeof body === "object" ? body : null;
  const code = Number(providerError?.code ?? error?.status ?? error?.statusCode);
  return {
    body: providerError,
    code: Number.isInteger(code) && code >= 400 && code <= 599 ? code : null,
    status: typeof providerError?.status === "string" ? providerError.status : null,
    message: typeof providerError?.message === "string" ? providerError.message : null,
    retryDelay: providerError?.details?.find?.(detail => /RetryInfo/.test(detail?.["@type"] || ""))?.retryDelay || null
  };
}

export function classifyGeminiQuota(providerError) {
  if (providerError?.code !== 429) return null;
  const message = providerError.message || "";
  const details = providerError.body?.details || [];
  const info = details.find(detail => /ErrorInfo/.test(detail?.["@type"] || "")) || {};
  const metadata = info.metadata || {};
  const quotaId = String(metadata.quotaId || metadata.quota_id || "");
  const quotaMetric = String(metadata.quotaMetric || metadata.quota_metric || "");
  const resourceNames = [metadata.model, metadata.modelId, metadata.model_id, metadata.consumer].filter(Boolean).join(" ");
  const text = `${message} ${quotaId} ${quotaMetric} ${resourceNames}`;
  if (!/daily|per.?day|requestsperday/i.test(text)) return null;
  // Google quota errors commonly include a quota ID / metric scoped per model.
  // If the provider gives no scope, fail closed as project-wide.
  if (/per.?model|model.*(request|quota|limit)|(?:^|\s)model(?:\s|$)/i.test(`${quotaId} ${quotaMetric} ${resourceNames}`)) return "model-daily";
  if (/project.?wide|per.?project(?!.*model)|project.*(request|quota|limit)/i.test(`${quotaId} ${quotaMetric} ${resourceNames} ${message}`)) return "project-wide";
  return "project-wide";
}

export function isDailyGeminiQuotaError(error) {
  if (error?.appBudgetExceeded) return false;
  if (getHttpStatus(error) !== 429) return false;
  const details = getProviderErrorDetails(error);
  const metadata = details.body?.details || [];
  const diagnostic = `${details.message || ""} ${JSON.stringify(metadata)}`;
  return /daily|per.?day|requestsperday/i.test(diagnostic);
}

export function userFacingGeminiError(error) {
  const status = getHttpStatus(error);
  if (error?.geminiNotConfigured) return "AI is not configured. Contact the administrator.";
  if (error?.appBudgetExceeded) return "TECHNOVALENS has reached its daily Gemini safety budget. Try a locally calculated question or continue tomorrow.";
  if (error?.geminiQueueTimeout) return "The AI request waited too long in the Gemini queue. Please try again shortly.";
  if (status === 504) return "Gemini timed out. Try a shorter PDF or ask for a more focused question.";
  if (status === 503) return "Gemini is temporarily unavailable. Please try again shortly.";
  if (status === 429) {
    if (error?.geminiBothModelQuotasExhausted) return "The daily Gemini request quotas for both configured models are exhausted. Try again after the quota resets or use a project with available model quota.";
    const providerMessage = getProviderErrorDetails(error).message || "";
    return isDailyGeminiQuotaError(error) || /project quota.*(?:exhausted|exceeded)|billing/i.test(providerMessage)
      ? "The Gemini project quota is exhausted. Check the project's quota or billing settings before trying again."
      : "Gemini is rate-limited. Please wait a moment and try again.";
  }
  if (status === 500) return "Gemini encountered an internal error. Please try again shortly.";
  if (status === 401) return "Gemini authentication failed. Check the backend API key configuration.";
  if (status === 403) return "Gemini access is forbidden. Check the API key permissions and model access.";
  if (status === 400 || status === 404 || status === 422) return "Gemini rejected this request. Try a shorter question or document, and check that the configured model supports this request.";
  return "Gemini could not analyse this file after retries. Please try again.";
}
