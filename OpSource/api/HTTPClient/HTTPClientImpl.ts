import noop from 'lodash/noop';
import { match } from 'ts-pattern';
import { Err, Ok, type Result } from 'ts-results';

import type { RefreshTokenSession, Session } from 'src/entities/Session/model/Session.types';
import type { AsyncQueue } from 'src/shared/lib/AsyncQueue';
import { boundMethod } from 'src/shared/lib/ClassHelpers';
import { PubSub, type Publisher, type StatefulPubSub } from 'src/shared/lib/PubSub';

import { ErrorHandlingResult } from './ErrorHandlingResult';
import type { CANCELED_REQUEST, CONNECTION_ERROR, RequestErrors, UNKNOWN_ERROR } from './GeneralErrors';
import type { HTTPClient } from './HTTPClient';
import { DefaultHttpRequestOptions, type HttpRequestOptions } from './HTTPRequestOptions';
import type { ProtocolResponse } from './ProtocolResponse';

type LogHTTPErrorsParams = Readonly<{
  result: Promise<Result<unknown, string>>;
  requestedMethod: string;
  requestedURL: string;
  requestedBody?: Nullable<object>;
  responseStatus?: Nullable<number>;
}>;

type DownloadFileAuthorizedParams<TBody extends object> =
  | {
      httpMethod: 'GET';
      headers?: HeadersInit;
    }
  | {
      httpMethod: 'POST';
      body: TBody | FormData;
      headers?: HeadersInit;
    };

export class HTTPClientImpl implements HTTPClient {
  readonly #fetch: typeof window.fetch;

  readonly #getAbsoluteUrl: (relativePath: string) => string;

  readonly #missingShiftSubscriber = new PubSub<void>();

  readonly #sessionPubSub: StatefulPubSub<Nullable<Session>>;

  readonly #sessionBroadcaster: Publisher<Nullable<Session>>;

  readonly #queue: AsyncQueue;

  readonly #authorizationHTTPClient: Nullable<HTTPClient>;

  readonly #reportErrorsIfAny: (params: LogHTTPErrorsParams) => void;

  public constructor(
    /**
     * Очередь, в которую будут ставиться все запросы
     */
    queue: AsyncQueue,
    /**
     * Хранилище состояния сессии
     */
    sessionPubSub: StatefulPubSub<Nullable<Session>>,

    /**
     * Отправляем события также и в другие вкладки с помощью броадкаста
     */
    sessionBroadcaster: Publisher<Nullable<Session>>,
    /**
     * fetch-like функция, который будет использоваться для похода по сети
     */
    fetch: typeof window.fetch,
    /**
     * Функция, которая будет резолвить базовый URL для HTTP-клиента
     */
    getAbsoluteUrl: (relativePath: string) => string,
    /**
     * HTTP-клиент, который будет использоваться для ротации токенов.
     * Если не передан, то будет использовать сам себя
     */
    authorizationHTTPClient: Nullable<HTTPClient> = null,

    reportErrorsIfAny: (
      params: Readonly<{
        result: Promise<Result<unknown, string>>;
        requestedMethod: string;
        requestedURL: string;
        requestedBody?: Nullable<object>;
        responseStatus?: Nullable<number>;
      }>,
    ) => void = noop,
  ) {
    this.#queue = queue;
    this.#sessionPubSub = sessionPubSub;
    this.#sessionBroadcaster = sessionBroadcaster;
    this.#fetch = fetch;
    this.#getAbsoluteUrl = getAbsoluteUrl;
    this.#authorizationHTTPClient = authorizationHTTPClient;
    this.#reportErrorsIfAny = reportErrorsIfAny;
  }

  private getBaseHeaders<TBody extends object>(params: { body?: TBody | FormData; accessToken?: string } = {}) {
    return {
      ...(params.accessToken ? { Authorization: `Bearer ${params.accessToken}` } : {}),
      Accept: 'application/json',
      ...(params.body && !(params.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private isAbortError(e: Error) {
    return e.name.toLowerCase() === 'aborterror';
  }

  private isResponseValidByProtocol(response: object): boolean {
    return 'error' in response || 'value' in response;
  }

  private async respondBlob<TError extends string>(response: Response): Promise<Result<Blob, TError | RequestErrors>> {
    if (response.status === 401) {
      return Err('STALE_ACCESS_TOKEN');
    }
    if (response.status === 403) {
      return Err('FORBIDDEN');
    }
    if (response.status === 404) {
      return Err('NOT_FOUND');
    }
    if (!response.ok) {
      return Err('UNKNOWN_ERROR');
    }
    try {
      const blobResponse: Blob = await response.blob();
      return Ok(blobResponse);
    } catch {
      return Err('UNKNOWN_ERROR');
    }
  }

  private async respondJSON<TResponse, TError extends string>(
    response: Response,
  ): Promise<Result<TResponse, TError | RequestErrors>> {
    if (response.status === 401) {
      return Err('STALE_ACCESS_TOKEN');
    }
    if (response.status === 403) {
      const jsonResponse: ProtocolResponse<TResponse> = (await response.json()) as ProtocolResponse<TResponse>;
      if (jsonResponse?.error === 'EXCEEDED_NUMBER_REQUEST_ATTEMPTS') {
        return Err(jsonResponse.error);
      }
      return Err('FORBIDDEN');
    }
    if (response.status === 404) {
      return Err('NOT_FOUND');
    }
    try {
      const jsonResponse: ProtocolResponse<TResponse> = (await response.json()) as ProtocolResponse<TResponse>;

      if (!this.isResponseValidByProtocol(jsonResponse)) {
        return Err('INVALID_PROTOCOL');
      }

      if (jsonResponse.error !== undefined && jsonResponse.error !== null) {
        /**
         * Здесь невозможно проверить тип, так как нам приходит строка, которую
         * нужно привести к одной из известных ошибок
         */
        const error = jsonResponse.error as TError | RequestErrors;
        return Err(error);
      }

      return Ok(jsonResponse.value);
    } catch {
      return Err('INVALID_PROTOCOL');
    }
  }

  private async tryHandleAuthorizationErrors<TResponse, TError extends string>(
    result: Result<TResponse, TError | RequestErrors>,
    shouldRetry: boolean,
  ): Promise<ErrorHandlingResult> {
    if (!result.err) {
      return ErrorHandlingResult.NO_ERRORS;
    }
    if (result.val === 'FORBIDDEN') {
      this.#sessionPubSub.publish(null);
      this.#sessionBroadcaster.publish(null);
      return ErrorHandlingResult.FORBIDDEN;
    }
    if (result.val === 'STALE_ACCESS_TOKEN' && shouldRetry) {
      const refreshToken = this.#sessionPubSub.value?.refreshToken;
      if (!refreshToken) {
        this.#sessionPubSub.publish(null);
        this.#sessionBroadcaster.publish(null);
        return ErrorHandlingResult.SESSION_REFRESH_FAILED;
      }
      const authorizationHTTPClient: HTTPClient = this.#authorizationHTTPClient ?? this;
      const result = await authorizationHTTPClient.authorizedPost<
        RefreshTokenSession,
        { readonly refreshToken: string }
      >('/auth/refresh', { refreshToken }, { disableRetryOnOutdatedToken: true, ignoreQueue: true });

      if (result.ok) {
        const sessionData = {
          ...result.val,
          refreshToken: result.val.refreshToken ?? this.#sessionPubSub.value.refreshToken,
        };
        this.#sessionPubSub.publish(sessionData);
        this.#sessionBroadcaster.publish(sessionData);
        return ErrorHandlingResult.SESSION_REFRESH_SUCCESS;
      } else {
        this.#sessionPubSub.publish(null);
        this.#sessionBroadcaster.publish(null);
        return ErrorHandlingResult.SESSION_REFRESH_FAILED;
      }
    }
    if (result.val === 'STALE_ACCESS_TOKEN' && !shouldRetry) {
      return ErrorHandlingResult.SESSION_REFRESH_FAILED;
    }
    if (result.val === 'NO_ACTIVE_SHIFT') {
      this.#missingShiftSubscriber.publish();
      return ErrorHandlingResult.MISSING_SHIFT;
    }
    return ErrorHandlingResult.UNKNOWN_ERROR;
  }

  private catchFetchErrors(e: unknown): Err<UNKNOWN_ERROR | CANCELED_REQUEST | CONNECTION_ERROR> {
    if (!(e instanceof Error)) {
      return Err('UNKNOWN_ERROR');
    }
    if (this.isAbortError(e)) {
      return Err('CANCELLED_REQUEST');
    }
    return Err('CONNECTION_ERROR');
  }

  @boundMethod
  public get<TResponse, TError extends string = string>(
    url: string,
    options?: HttpRequestOptions,
  ): Promise<Result<TResponse, TError | RequestErrors>> {
    let lastStatus: Nullable<number> = null;
    const task = async (options?: HttpRequestOptions): Promise<Result<TResponse, TError | RequestErrors>> => {
      const actualOptions = new DefaultHttpRequestOptions().merge(options);
      const absoluteURL = this.#getAbsoluteUrl(url);
      try {
        const response = await this.#fetch(absoluteURL, {
          method: 'GET',
          signal: actualOptions.abortController.signal,
          headers: this.getBaseHeaders(),
        });
        lastStatus = response.status;
        const result = await this.respondJSON<TResponse, TError>(response);
        await this.tryHandleAuthorizationErrors(result, false);
        return result;
      } catch (e) {
        return this.catchFetchErrors(e);
      }
    };
    const result = options?.ignoreQueue ? task(options) : this.#queue.pushAndGetResult(() => task(options));
    result.finally(() => {
      this.#reportErrorsIfAny({
        requestedMethod: 'GET',
        requestedURL: url,
        result,
        requestedBody: null,
        responseStatus: lastStatus,
      });
    });

    return result;
  }

  @boundMethod
  public post<TResponse, TBody extends object, TError extends string = string>(
    url: string,
    body: TBody | FormData,
    options?: HttpRequestOptions,
  ): Promise<Result<TResponse, TError | RequestErrors>> {
    let lastStatus: Nullable<number> = null;
    const task = async (options?: HttpRequestOptions): Promise<Result<TResponse, TError | RequestErrors>> => {
      const actualOptions = new DefaultHttpRequestOptions().merge(options);
      const absoluteURL = this.#getAbsoluteUrl(url);
      try {
        const response = await this.#fetch(absoluteURL, {
          method: 'POST',
          signal: actualOptions.abortController.signal,
          headers: this.getBaseHeaders({ body }),
          body: body instanceof FormData ? body : JSON.stringify(body),
        });
        lastStatus = response.status;
        const result = await this.respondJSON<TResponse, TError>(response);
        await this.tryHandleAuthorizationErrors(result, false);
        return result;
      } catch (e) {
        return this.catchFetchErrors(e);
      }
    };
    const result = options?.ignoreQueue ? task(options) : this.#queue.pushAndGetResult(task);
    result.finally(() => {
      this.#reportErrorsIfAny({
        requestedMethod: 'POST',
        requestedURL: url,
        requestedBody: body,
        result,
        responseStatus: lastStatus,
      });
    });

    return result;
  }

  @boundMethod
  public authorizedGet<TResponse, TError extends string = string>(
    url: string,
    options?: HttpRequestOptions,
  ): Promise<Result<TResponse, TError | RequestErrors>> {
    let lastStatus: Nullable<number> = null;
    const task = async (options?: HttpRequestOptions): Promise<Result<TResponse, TError | RequestErrors>> => {
      if (!this.#sessionPubSub.value) {
        return Err('STALE_ACCESS_TOKEN');
      }
      const actualOptions = new DefaultHttpRequestOptions().merge(options);
      const absoluteURL = this.#getAbsoluteUrl(url);
      try {
        const response = await this.#fetch(absoluteURL, {
          method: 'GET',
          signal: actualOptions.abortController.signal,
          headers: this.getBaseHeaders({ accessToken: this.#sessionPubSub.value.accessToken }),
        });
        lastStatus = response.status;
        const result = await this.respondJSON<TResponse, TError>(response);
        const errorHandlingResult = await this.tryHandleAuthorizationErrors(
          result,
          !actualOptions.disableRetryOnOutdatedToken,
        );
        if (errorHandlingResult === ErrorHandlingResult.SESSION_REFRESH_SUCCESS) {
          return task(
            new DefaultHttpRequestOptions().merge({
              ...actualOptions,
              disableRetryOnOutdatedToken: true,
            }),
          );
        }
        return result;
      } catch (e) {
        return this.catchFetchErrors(e);
      }
    };
    const result = options?.ignoreQueue ? task(options) : this.#queue.pushAndGetResult(() => task(options));
    result.finally(() => {
      this.#reportErrorsIfAny({
        requestedMethod: 'GET',
        requestedURL: url,
        result,
        requestedBody: null,
        responseStatus: lastStatus,
      });
    });
    return result;
  }

  @boundMethod
  public authorizedPost<TResponse, TBody extends object, TError extends string = string>(
    url: string,
    body: TBody | FormData,
    options?: HttpRequestOptions,
  ): Promise<Result<TResponse, TError | RequestErrors>> {
    let lastStatus: Nullable<number> = null;
    const task = async (options?: HttpRequestOptions): Promise<Result<TResponse, TError | RequestErrors>> => {
      if (!this.#sessionPubSub.value) {
        return Err('STALE_ACCESS_TOKEN');
      }
      const actualOptions = new DefaultHttpRequestOptions().merge(options);
      const absoluteURL = this.#getAbsoluteUrl(url);
      try {
        const response = await this.#fetch(absoluteURL, {
          method: 'POST',
          signal: actualOptions.abortController.signal,
          headers: this.getBaseHeaders({ accessToken: this.#sessionPubSub.value.accessToken, body }),
          body: body instanceof FormData ? body : JSON.stringify(body),
        });
        lastStatus = response.status;
        const result = await this.respondJSON<TResponse, TError>(response);
        const errorHandlingResult = await this.tryHandleAuthorizationErrors(
          result,
          !actualOptions.disableRetryOnOutdatedToken,
        );
        if (errorHandlingResult === ErrorHandlingResult.SESSION_REFRESH_SUCCESS) {
          return task(
            new DefaultHttpRequestOptions().merge({
              ...actualOptions,
              disableRetryOnOutdatedToken: true,
            }),
          );
        }
        return result;
      } catch (e) {
        return this.catchFetchErrors(e);
      }
    };
    const result = options?.ignoreQueue ? task(options) : this.#queue.pushAndGetResult(() => task(options));
    result.finally(() => {
      this.#reportErrorsIfAny({
        requestedMethod: 'POST',
        requestedURL: url,
        requestedBody: body,
        result,
        responseStatus: lastStatus,
      });
    });
    return result;
  }

  @boundMethod
  public async downloadFileAuthorized<TBody extends object, TError extends string = string>(
    url: string,
    init: DownloadFileAuthorizedParams<TBody>,
    options?: HttpRequestOptions,
  ): Promise<Result<Blob, RequestErrors | TError>> {
    let lastStatus: Nullable<number> = null;
    const task = async (options?: HttpRequestOptions): Promise<Result<Blob, RequestErrors | TError>> => {
      if (!this.#sessionPubSub.value) {
        return Err('STALE_ACCESS_TOKEN');
      }

      const actualOptions = new DefaultHttpRequestOptions().merge(options);
      const absoluteURL = this.#getAbsoluteUrl(url);

      try {
        const body = init.httpMethod === 'POST' ? init.body : undefined;
        const response = await this.#fetch(absoluteURL, {
          method: init.httpMethod,
          signal: actualOptions.abortController.signal,
          headers: {
            ...this.getBaseHeaders({ accessToken: this.#sessionPubSub.value.accessToken, body }),
            ...(init.headers ? init.headers : {}),
          },
          body: body instanceof FormData ? body : JSON.stringify(body),
        });
        lastStatus = response.status;
        const result = await this.respondBlob<TError>(response);
        const errorHandlingResult = await this.tryHandleAuthorizationErrors(
          result,
          !actualOptions.disableRetryOnOutdatedToken,
        );
        if (errorHandlingResult === ErrorHandlingResult.SESSION_REFRESH_SUCCESS) {
          return task(
            new DefaultHttpRequestOptions().merge({
              ...actualOptions,
              disableRetryOnOutdatedToken: true,
            }),
          );
        }
        return result;
      } catch (e) {
        return this.catchFetchErrors(e);
      }
    };
    const result = options?.ignoreQueue ? task(options) : this.#queue.pushAndGetResult(() => task(options));
    result.finally(() => {
      this.#reportErrorsIfAny({
        requestedMethod: init.httpMethod.toLocaleUpperCase(),
        requestedURL: url,
        result,
        requestedBody: match(init)
          .with({ httpMethod: 'GET' }, () => null)
          .with({ httpMethod: 'POST' }, ({ body }) => {
            return body instanceof FormData ? [...body.entries()] : body;
          })
          .exhaustive(),
        responseStatus: lastStatus,
      });
    });
    return result;
  }

  public get missingShiftSubscriber() {
    return this.#missingShiftSubscriber;
  }
}
