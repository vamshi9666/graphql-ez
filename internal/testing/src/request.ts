import { documentParamsToURIParams } from '@graphql-ez/utils/clientURI';
import { LazyPromise } from '@graphql-ez/utils/promise';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { DocumentNode, ExecutionResult, print } from 'graphql';
import type { IncomingHttpHeaders } from 'http';
import { Pool } from 'undici';
import type { RequestOptions } from 'undici/types/dispatcher';
import { TearDownPromises } from './common';

export type { RequestOptions, TypedDocumentNode };

export async function getStringFromStream(stream: import('stream').Readable): Promise<string> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf-8');
}

export async function getJSONFromStream<T>(stream: import('stream').Readable): Promise<T> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

export function getRequestPool(port: number, path = '/graphql') {
  const address = `http://127.0.0.1:${port}`;
  const addressWithoutProtocol = `127.0.0.1:${port}`;
  const requestPool = new Pool(address, {
    connections: 5,
    bodyTimeout: 0,
  });

  TearDownPromises.push(LazyPromise(() => requestPool.close()));

  return {
    address,
    addressWithoutProtocol,
    async request(options: Omit<RequestOptions, 'origin'>) {
      const { body } = await requestPool.request({ ...options, origin: address });

      return getStringFromStream(body);
    },

    async requestRaw(options: Omit<RequestOptions, 'origin'>) {
      const { body, ...rest } = await requestPool.request({ ...options, origin: address });

      return { body: getStringFromStream(body), ...rest };
    },
    async query<TData, TVariables = {}>(
      document?: TypedDocumentNode<TData, TVariables> | string,
      options?: {
        variables?: TVariables;
        headers?: IncomingHttpHeaders;
        extensions?: Record<string, unknown>;
        operationName?: string;
        /**
         * @default "POST"
         */
        method?: 'POST' | 'GET';
      }
    ): Promise<ExecutionResult<TData> & { http: { statusCode: number; headers: IncomingHttpHeaders } }> {
      const { variables, headers: headersArg, extensions, operationName, method = 'POST' } = options || {};
      const {
        body,
        headers: { date, ...headers },
        statusCode,
      } = await requestPool.request(
        method === 'POST'
          ? {
              origin: address,
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...headersArg,
              },
              body: JSON.stringify({
                query: typeof document === 'string' ? document : document && print(document),
                variables,
                extensions,
                operationName,
              }),
              path,
            }
          : {
              origin: address,
              method: 'GET',
              headers: {
                'content-type': 'application/json',
                ...headersArg,
              },
              path: path + documentParamsToURIParams({ query: document || '', extensions, operationName, variables }),
            }
      );

      if (!headers['content-type']?.startsWith('application/json')) {
        console.error({
          body: await getStringFromStream(body),
          headers,
        });
        throw Error('Unexpected content type received: ' + headers['content-type']);
      }

      return { ...(await getJSONFromStream(body)), http: { statusCode, headers } };
    },
    async batchedQueries(
      queries: Array<{
        query?: DocumentNode | string;
        variables?: Record<string, unknown>;
        extensions?: Record<string, unknown>;
        operationName?: string;
      }>,
      options?: { headers?: IncomingHttpHeaders }
    ): Promise<{
      result: Array<ExecutionResult<Record<string, any>>>;
      http: { statusCode: number; headers: IncomingHttpHeaders };
    }> {
      const {
        body,
        headers: { date, ...headers },
        statusCode,
      } = await requestPool.request({
        origin: address,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...options?.headers,
        },
        body: JSON.stringify(
          queries.map(({ query, variables, extensions, operationName }) => {
            return {
              query: typeof query === 'string' ? query : query && print(query),
              variables,
              extensions,
              operationName,
            };
          })
        ),
        path,
      });

      if (!headers['content-type']?.startsWith('application/json')) {
        console.error({
          body: await getStringFromStream(body),
          headers,
        });
        throw Error('Unexpected content type received: ' + headers['content-type']);
      }

      return { result: await getJSONFromStream(body), http: { statusCode, headers } };
    },
  };
}
