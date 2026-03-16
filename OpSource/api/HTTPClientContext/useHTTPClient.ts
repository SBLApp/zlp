import * as React from 'react';

import type { HTTPClient } from '../HTTPClient/HTTPClient';

import { HTTPClientContext } from './HTTPClientContext';

const useHTTPClients = () => {
  const httpClients = React.useContext(HTTPClientContext);
  if (!httpClients) {
    throw new Error('HTTPClientProvider is missing');
  }
  return httpClients;
};

export const useWMSINHTTPClient = (): HTTPClient => {
  return useHTTPClients().wmsinClient;
};

export const useWMSOUTHTTPClient = (): HTTPClient => {
  return useHTTPClients().wmsoutClient;
};

export const useWMSOPSHTTPClient = (): HTTPClient => {
  return useHTTPClients().wmsopsClient;
};
