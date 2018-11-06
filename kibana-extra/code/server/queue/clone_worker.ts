/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { EsClient, Esqueue } from '@code/esqueue';

import { RepositoryUtils } from '../../common/repository_utils';
import { CloneProgress, CloneWorkerProgress, CloneWorkerResult } from '../../model';
import { Log } from '../log';
import { RepositoryService } from '../repository_service';
import { RepositoryObjectClient } from '../search';
import { SocketService } from '../socket_service';
import { AbstractGitWorker } from './abstract_git_worker';
import { IndexWorker } from './index_worker';
import { Job } from './job';

export class CloneWorker extends AbstractGitWorker {
  public id: string = 'clone';

  constructor(
    protected readonly queue: Esqueue,
    protected readonly log: Log,
    protected readonly client: EsClient,
    private readonly indexWorker: IndexWorker,
    private readonly socketService?: SocketService
  ) {
    super(queue, log, client);
  }

  public async executeJob(job: Job) {
    const { url, dataPath } = job.payload;
    this.log.info(`Execute clone job for ${url}`);
    const repoService = new RepositoryService(dataPath, this.log);
    const repo = RepositoryUtils.buildRepository(url);
    return await repoService.clone(repo, (progress: number, cloneProgress?: CloneProgress) => {
      this.updateProgress(repo.uri, progress, cloneProgress);
      if (this.socketService) {
        this.socketService.boardcastCloneProgress(repo.uri, progress, cloneProgress);
      }
    });
  }

  public async onJobCompleted(job: Job, res: CloneWorkerResult) {
    this.log.info(`Clone job done for ${res.repo.uri}`);

    if (this.socketService) {
      this.socketService.boardcastCloneProgress(res.repo.uri, 100, undefined);
    }

    // Throw out a repository index request.
    const { dataPath } = job.payload;
    const payload = {
      uri: res.repo.uri,
      revision: res.repo.revision,
      dataPath,
    };
    await this.indexWorker.enqueueJob(payload, {});

    return await super.onJobCompleted(job, res);
  }

  public async onJobEnqueued(job: Job) {
    const { url } = job.payload;
    const repo = RepositoryUtils.buildRepository(url);
    const progress: CloneWorkerProgress = {
      uri: repo.uri,
      progress: 0,
      timestamp: new Date(),
    };
    return await this.objectClient.setRepositoryGitStatus(repo.uri, progress);
  }
}
