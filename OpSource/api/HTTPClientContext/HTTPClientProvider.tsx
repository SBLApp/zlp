import * as React from 'react';

import type { Session } from 'src/entities/Session/model/Session.types';
import { reportErrorsIfAny } from 'src/shared/api/HTTPClient/Telemetry';
import { AsyncQueue } from 'src/shared/lib/AsyncQueue';
import {
  getWMSINAbsoluteURL,
  getWMSOPSAbsoluteURL,
  getWMSOUTAbsoluteURL,
} from 'src/shared/lib/PathResolver/PathResolver';
import type { Publisher, StatefulPubSub } from 'src/shared/lib/PubSub';

import { HTTPClientImpl } from '../HTTPClient/HTTPClientImpl';

import { HTTPClientContext } from './HTTPClientContext';

const fetchBound = window.fetch.bind(window);

export const HTTPClientProvider = (
  props: Readonly<{
    children: React.ReactNode;
    sessionPubSub: StatefulPubSub<Nullable<Session>>;
    sessionBroadcast: Publisher<Nullable<Session>>;
  }>,
) => {
  const { sessionPubSub, sessionBroadcast } = props;
  const [queue] = React.useState(() => new AsyncQueue());

  const [wmsinClient, updateWMSINClient] = React.useState(
    () =>
      new HTTPClientImpl(
        queue,
        sessionPubSub,
        sessionBroadcast,
        fetchBound,
        getWMSINAbsoluteURL,
        null,
        reportErrorsIfAny,
      ),
  );
  React.useEffect(() => {
    updateWMSINClient(
      new HTTPClientImpl(
        queue,
        sessionPubSub,
        sessionBroadcast,
        fetchBound,
        getWMSINAbsoluteURL,
        null,
        reportErrorsIfAny,
      ),
    );
  }, [queue, sessionBroadcast, sessionPubSub]);

  const [wmsoutClient, updateWMSOUTClient] = React.useState(
    () =>
      new HTTPClientImpl(
        queue,
        sessionPubSub,
        sessionBroadcast,
        fetchBound,
        getWMSOUTAbsoluteURL,
        wmsinClient,
        reportErrorsIfAny,
      ),
  );
  React.useEffect(() => {
    updateWMSOUTClient(
      new HTTPClientImpl(
        queue,
        sessionPubSub,
        sessionBroadcast,
        fetchBound,
        getWMSOUTAbsoluteURL,
        wmsinClient,
        reportErrorsIfAny,
      ),
    );
  }, [queue, sessionBroadcast, sessionPubSub, wmsinClient]);

  const [wmsopsClient, updateWMSOPSClient] = React.useState(
    () =>
      new HTTPClientImpl(
        queue,
        sessionPubSub,
        sessionBroadcast,
        fetchBound,
        getWMSOPSAbsoluteURL,
        wmsinClient,
        reportErrorsIfAny,
      ),
  );
  React.useEffect(() => {
    updateWMSOPSClient(
      new HTTPClientImpl(
        queue,
        sessionPubSub,
        sessionBroadcast,
        fetchBound,
        getWMSOPSAbsoluteURL,
        wmsinClient,
        reportErrorsIfAny,
      ),
    );
  }, [queue, sessionBroadcast, sessionPubSub, wmsinClient]);

  const contextValue = React.useMemo(() => {
    return { wmsinClient, wmsoutClient, wmsopsClient };
  }, [wmsinClient, wmsoutClient, wmsopsClient]);

  return <HTTPClientContext.Provider value={contextValue}>{props.children}</HTTPClientContext.Provider>;
};
