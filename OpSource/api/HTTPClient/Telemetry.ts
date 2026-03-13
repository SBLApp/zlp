import { EventNotifier } from '@ecom-web/react-core';
import type { Result } from 'ts-results';

import type { RequestErrors, TECHNICAL_ERROR } from './GeneralErrors';

const logErrors: ReadonlySet<string> = new Set([
  'INVALID_PROTOCOL',
  'UNKNOWN_ERROR',
  'TECHNICAL_ERROR',
] as const satisfies ReadonlyArray<RequestErrors | TECHNICAL_ERROR>);

export const reportErrorsIfAny = async (
  params: Readonly<{
    result: Promise<Result<unknown, string>>;
    requestedMethod: string;
    requestedURL: string;
    requestedBody?: Nullable<object>;
    responseStatus?: Nullable<number>;
  }>,
) => {
  const { requestedMethod, requestedURL, result, requestedBody, responseStatus } = params;
  if (!EventNotifier.getProvider()) {
    return;
  }

  const extra = {
    requestedMethod,
    requestedURL,
    requestedBody: requestedBody ? JSON.stringify(requestedBody) : null,
    response: (await result).unwrapOr(null),
    responseStatus: responseStatus || null,
  };

  result
    .then((result) => {
      const shouldSendError = result.err && logErrors.has(result.val);
      if (shouldSendError) {
        EventNotifier.notify(result.val, { level: 'error', extra });
      }
    })
    .catch((error) => {
      EventNotifier.notify(error, { level: 'error', extra });
      return null;
    });
};
