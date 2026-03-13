import * as React from 'react';

import type { HTTPClient } from '../HTTPClient/HTTPClient';

interface HTTPClients {
  readonly wmsinClient: HTTPClient;
  readonly wmsoutClient: HTTPClient;
  readonly wmsopsClient: HTTPClient;
}

export const HTTPClientContext = React.createContext<HTTPClients | null>(null);
