import { type NextRequest, NextResponse } from 'next/server';

import { BATCH_ACTION_BATCHER_DOMAIN } from '@/route-handlers/list-batch-actions/list-batch-actions.constants';
import { getHTTPStatusCode, GRPCError } from '@/utils/grpc/grpc-error';
import logger, { type RouteHandlerErrorPayload } from '@/utils/logger';

import {
  type Context,
  type DescribeBatchActionResponse,
  type RequestParams,
} from './describe-batch-action.types';
import getBatchActionDetailFromWorkflow from './helpers/get-batch-action-detail-from-workflow';
import getBatchActionInputFromHistory from './helpers/get-batch-action-input-from-history';
import {
  getFinalProgressFromCloseEvent,
  getLastProgressFromHistory,
  getRunningProgressFromDescribe,
} from './helpers/get-batch-action-progress';

export async function describeBatchAction(
  _: NextRequest,
  requestParams: RequestParams,
  ctx: Context
) {
  const params = requestParams.params;

  const workflowExecution = {
    workflowId: params.batchActionId,
    runId: '',
  };

  try {
    const [describeResponse, historyResponse] = await Promise.all([
      ctx.grpcClusterMethods.describeWorkflow({
        domain: BATCH_ACTION_BATCHER_DOMAIN,
        workflowExecution,
      }),
      ctx.grpcClusterMethods.getHistory({
        domain: BATCH_ACTION_BATCHER_DOMAIN,
        workflowExecution,
        pageSize: 1,
      }),
    ]);

    const detail = getBatchActionDetailFromWorkflow(describeResponse);
    if (!detail) {
      return NextResponse.json(
        { message: 'Batch action not found' },
        { status: 404 }
      );
    }

    const response = {
      ...detail,
      ...getBatchActionInputFromHistory(historyResponse),
    } satisfies DescribeBatchActionResponse;

    if (detail.status === 'RUNNING') {
      // Progress is surfaced live on the batcher activity's heartbeat.
      response.progress = getRunningProgressFromDescribe(describeResponse);
    } else if (detail.status === 'COMPLETED') {
      // The final counts live in the workflow's close event. Reading them is a
      // best-effort enrichment — a failure here should not fail the request.
      try {
        const closeEventResponse = await ctx.grpcClusterMethods.getHistory({
          domain: BATCH_ACTION_BATCHER_DOMAIN,
          workflowExecution,
          historyEventFilterType: 'EVENT_FILTER_TYPE_CLOSE_EVENT',
        });
        response.progress = getFinalProgressFromCloseEvent(
          closeEventResponse.history?.events?.[0]
        );
      } catch (e) {
        logger.error<RouteHandlerErrorPayload>(
          { requestParams: params, error: e },
          'Failed to read batch action progress from close event'
        );
      }
    } else if (detail.status === 'FAILED') {
      // On a workflow-level timeout the batcher activity is still pending and its
      // last heartbeat is on the describe response (same source as RUNNING).
      response.progress = getRunningProgressFromDescribe(describeResponse);

      // On an activity-level timeout the activity is gone from pendingActivities,
      // but its final heartbeat is preserved on the ActivityTaskTimedOut event.
      if (!response.progress) {
        try {
          const fullHistoryResponse = await ctx.grpcClusterMethods.getHistory({
            domain: BATCH_ACTION_BATCHER_DOMAIN,
            workflowExecution,
          });
          response.progress = getLastProgressFromHistory(
            fullHistoryResponse.history?.events
          );
        } catch (e) {
          logger.error<RouteHandlerErrorPayload>(
            { requestParams: params, error: e },
            'Failed to read last batch action progress from history'
          );
        }
      }
    }

    return NextResponse.json(response);
  } catch (e) {
    logger.error<RouteHandlerErrorPayload>(
      { requestParams: params, error: e },
      'Error fetching batch action' +
        (e instanceof GRPCError ? ': ' + e.message : '')
    );

    return NextResponse.json(
      {
        message:
          e instanceof GRPCError ? e.message : 'Error fetching batch action',
        cause: e,
      },
      {
        status: getHTTPStatusCode(e),
      }
    );
  }
}
