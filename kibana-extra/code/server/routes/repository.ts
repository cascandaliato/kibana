/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import Boom from 'boom';

import hapi from 'hapi';
import { isValidGitUrl } from '../../common/git_url_utils';
import { RepositoryUtils } from '../../common/repository_utils';
import { Repository } from '../../model';
import { RepositoryIndexInitializerFactory } from '../indexer';
import {
  RepositoryIndexNamePrefix,
  RepositoryReservedField,
  RepositoryTypeName,
} from '../indexer/schema';
import { Log } from '../log';
import { CloneWorker, DeleteWorker, IndexWorker } from '../queue';
import { RepositoryObjectClient } from '../search';
import { ServerOptions } from '../server_options';

export function repositoryRoute(
  server: hapi.Server,
  options: ServerOptions,
  cloneWorker: CloneWorker,
  deleteWorker: DeleteWorker,
  indexWorker: IndexWorker,
  repoIndexInitializerFactory: RepositoryIndexInitializerFactory
) {
  // Clone a git repository
  server.route({
    path: '/api/code/repo',
    method: 'POST',
    async handler(req, h) {
      const repoUrl: string = req.payload.url;
      const log = new Log(req.server);

      // Reject the request if the url is an invalid git url.
      if (!isValidGitUrl(repoUrl)) {
        return Boom.badRequest('Invalid git url.');
      }

      const repo = RepositoryUtils.buildRepository(repoUrl);
      const objectClient = new RepositoryObjectClient(
        req.server.plugins.elasticsearch.getCluster('data').getClient()
      );

      try {
        // Check if the repository already exists
        await objectClient.getRepository(repo.uri);
        const msg = `Repository ${repoUrl} already exists. Skip clone.`;
        log.info(msg);
        return h.response(msg).code(304); // Not Modified
      } catch (error) {
        log.info(`Repository ${repoUrl} does not exist. Go ahead with clone.`);
        try {
          // Create the index for the repository
          await repoIndexInitializerFactory.create(repo.uri, '').init();

          // Persist to elasticsearch
          await objectClient.setRepository(repo.uri, repo);

          // Kick off clone job
          const payload = {
            url: repoUrl,
            dataPath: options.repoPath,
          };
          await cloneWorker.enqueueJob(payload, {});
          return repo;
        } catch (error) {
          const msg = `Issue repository clone request for ${repoUrl} error: ${error}`;
          log.error(msg);
          return Boom.badRequest(msg);
        }
      }
    },
  });

  // Remove a git repository
  server.route({
    path: '/api/code/repo/{uri*3}',
    method: 'DELETE',
    async handler(req) {
      const repoUri: string = req.params.uri as string;
      const log = new Log(req.server);
      const objectClient = new RepositoryObjectClient(
        req.server.plugins.elasticsearch.getCluster('data').getClient()
      );
      try {
        // Delete the repository from ES.
        // If object does not exist in ES, an error will be thrown.
        await objectClient.deleteRepository(repoUri);

        const payload = {
          uri: repoUri,
          dataPath: options.repoPath,
        };
        await deleteWorker.enqueueJob(payload, {});

        return {};
      } catch (error) {
        const msg = `Issue repository delete request for ${repoUri} error: ${error}`;
        log.error(msg);
        return Boom.notFound(msg);
      }
    },
  });

  // Get a git repository
  server.route({
    path: '/api/code/repo/{uri*3}',
    method: 'GET',
    async handler(req) {
      const repoUri = req.params.uri as string;
      const log = new Log(req.server);
      try {
        const objectClient = new RepositoryObjectClient(
          req.server.plugins.elasticsearch.getCluster('data').getClient()
        );
        return await objectClient.getRepository(repoUri);
      } catch (error) {
        const msg = `Get repository ${repoUri} error: ${error}`;
        log.error(msg);
        return Boom.notFound(msg);
      }
    },
  });

  server.route({
    path: '/api/code/repoCloneStatus/{uri*3}',
    method: 'GET',
    async handler(req) {
      const repoUri = req.params.uri as string;
      const log = new Log(req.server);
      try {
        const objectClient = new RepositoryObjectClient(
          req.server.plugins.elasticsearch.getCluster('data').getClient()
        );
        return await objectClient.getRepositoryGitStatus(repoUri);
      } catch (error) {
        const msg = `Get repository clone status ${repoUri} error: ${error}`;
        log.error(msg);
        return Boom.notFound(msg);
      }
    },
  });

  // Get all git repositories
  server.route({
    path: '/api/code/repos',
    method: 'GET',
    async handler(req) {
      const log = new Log(req.server);
      const { callWithRequest } = req.server.plugins.elasticsearch.getCluster('data');
      try {
        const response = await callWithRequest(req, 'search', {
          index: `${RepositoryIndexNamePrefix}*`,
          type: RepositoryTypeName,
          body: {
            query: {
              exists: {
                field: RepositoryReservedField,
              },
            },
          },
          from: 0,
          size: 10000,
        });
        const hits: any[] = response.hits.hits;
        const repos: Repository[] = hits.map(hit => {
          const repo: Repository = hit._source[RepositoryReservedField];
          return repo;
        });
        return repos;
      } catch (error) {
        const msg = `Get all repositories error: ${error}`;
        log.error(msg);
        return Boom.notFound(msg);
      }
    },
  });

  // Issue a repository index task.
  // TODO(mengwei): This is just temprorary API stub to trigger the index job. Eventually in the near
  // future, this route will be removed. The scheduling strategy is still in discussion.
  server.route({
    path: '/api/code/repo/index/{uri*3}',
    method: 'POST',
    async handler(req) {
      const repoUri = req.params.uri as string;
      const log = new Log(req.server);
      try {
        const objectClient = new RepositoryObjectClient(
          req.server.plugins.elasticsearch.getCluster('data').getClient()
        );
        const cloneStatus = await objectClient.getRepositoryGitStatus(repoUri);

        const payload = {
          uri: repoUri,
          revision: cloneStatus.revision,
          dataPath: options.repoPath,
        };
        await indexWorker.enqueueJob(payload, {});
        return {};
      } catch (error) {
        const msg = `Index repository ${repoUri} error: ${error}`;
        log.error(msg);
        return Boom.notFound(msg);
      }
    },
  });
}
