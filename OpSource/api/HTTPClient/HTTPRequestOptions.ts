export interface HttpRequestOptions {
  /**
   * Надо ли отменять запрос при отписке от Observable
   */
  readonly abortController?: AbortController;

  /**
   * Надо ли отказаться от незаметного обновления токена при запросе.
   * Актуально только для запросов, требующих авторизацию
   */
  readonly disableRetryOnOutdatedToken?: boolean;

  /**
   * Надо ли игнорировать очередь запросов. По умолчанию всегда не надо,
   * кроме непредвиденных случаев когда нужно выполнить запрос минуя очередь.
   * Обычно применяется во внутренней реализации HTTPClientImpl, но если все же
   * необходимо проигнорировать очередь в коде какого-либо запроса, то стоит
   * подумать о последствиях, потому что есть более важные запросы, касающиеся авторизации,
   * которые должны быть точно выполнены прежде чем выполнится необходимый запрос.
   * В противном случае можно получить ошибку авторизации (если токен протухнет)
   */
  readonly ignoreQueue?: boolean;
}

export class DefaultHttpRequestOptions implements Required<HttpRequestOptions> {
  public readonly abortController = new AbortController();

  public readonly disableRetryOnOutdatedToken = false;

  public readonly ignoreQueue = false;

  public merge(options?: HttpRequestOptions): Required<HttpRequestOptions> {
    return {
      abortController: options?.abortController ?? this.abortController,
      disableRetryOnOutdatedToken: options?.disableRetryOnOutdatedToken ?? this.disableRetryOnOutdatedToken,
      ignoreQueue: options?.ignoreQueue ?? this.ignoreQueue,
    };
  }
}
