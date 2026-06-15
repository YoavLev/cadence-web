import { status } from '@grpc/grpc-js';
import { NextRequest } from 'next/server';

import { type DescribeWorkflowExecutionResponse } from '@/__generated__/proto-ts/uber/cadence/api/v1/DescribeWorkflowExecutionResponse';
import { type GetWorkflowExecutionHistoryResponse } from '@/__generated__/proto-ts/uber/cadence/api/v1/GetWorkflowExecutionHistoryResponse';
import { GRPCError } from '@/utils/grpc/grpc-error';
import logger from '@/utils/logger';
import { mockGrpcClusterMethods } from '@/utils/route-handlers-middleware/middlewares/__mocks__/grpc-cluster-methods';

import {
  mockBatcherActivityTimedOutHistory,
  mockBatcherCloseEventHistory,
  mockBatcherStartedHistory,
  mockBatcherStartedHistoryWithUnknownType,
  mockBatcherWorkflowTimedOutHistory,
  mockDescribeBatchOperationWorkflowCompleted,
  mockDescribeBatchOperationWorkflowFailed,
  mockDescribeBatchOperationWorkflowFailedWithPendingProgress,
  mockDescribeBatchOperationWorkflowRunning,
  mockDescribeBatchOperationWorkflowRunningWithProgress,
  mockDescribeBatchOperationWorkflowTerminated,
  MOCK_BATCH_PROGRESS,
} from '../__fixtures__/mock-describe-batch-operation-workflow';
import { describeBatchAction } from '../describe-batch-action';
import {
  type Context,
  type RequestParams,
} from '../describe-batch-action.types';

jest.mock('@/utils/logger');

describe(describeBatchAction.name, () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('calls describeWorkflow and getHistory against cadence-batcher in parallel and merges input fields into the response', async () => {
    const { res, mockDescribeWorkflow, mockGetHistory } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowCompleted,
    });

    expect(mockDescribeWorkflow).toHaveBeenCalledWith({
      domain: 'cadence-batcher',
      workflowExecution: {
        workflowId: 'mock-batch-action-id-1',
        runId: '',
      },
    });
    expect(mockGetHistory).toHaveBeenCalledWith({
      domain: 'cadence-batcher',
      workflowExecution: {
        workflowId: 'mock-batch-action-id-1',
        runId: '',
      },
      pageSize: 1,
    });

    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({
      id: 'mock-batch-action-id-1',
      status: 'COMPLETED',
      startTime: 1717408148258,
      endTime: 1717409148258,
      actionType: 'terminate',
      rps: 100,
    });
  });

  it('returns running status and undefined endTime for an in-flight batch action', async () => {
    const { res } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowRunning,
    });

    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(body.status).toEqual('RUNNING');
    expect(body.endTime).toBeUndefined();
    expect(body.startTime).toEqual(1717408148258);
  });

  it('maps TERMINATED close status to aborted', async () => {
    const { res } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowTerminated,
    });

    expect(res.status).toEqual(200);
    expect((await res.json()).status).toEqual('ABORTED');
  });

  it('returns 500 and logs when BatchType in input is not a UI-supported value', async () => {
    const { res } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowRunning,
      historyResponse: mockBatcherStartedHistoryWithUnknownType,
    });

    expect(res.status).toEqual(500);
    expect(await res.json()).toEqual(
      expect.objectContaining({ message: 'Error fetching batch action' })
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        requestParams: {
          domain: 'mock-domain',
          cluster: 'mock-cluster',
          batchActionId: 'mock-batch-action-id-1',
        },
        error: expect.any(Error),
      }),
      'Error fetching batch action'
    );
  });

  it('populates progress from the running activity heartbeat', async () => {
    const { res } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowRunningWithProgress,
    });

    const body = await res.json();
    expect(body.status).toEqual('RUNNING');
    expect(body.progress).toEqual({
      totalEstimate: MOCK_BATCH_PROGRESS.TotalEstimate,
      successCount: MOCK_BATCH_PROGRESS.SuccessCount,
      errorCount: MOCK_BATCH_PROGRESS.ErrorCount,
    });
  });

  it('leaves progress undefined for a running batch with no heartbeat yet', async () => {
    const { res } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowRunning,
    });

    const body = await res.json();
    expect(body.status).toEqual('RUNNING');
    expect(body.progress).toBeUndefined();
  });

  it('populates final progress from the close event for a completed batch', async () => {
    const { res, mockGetHistory } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowCompleted,
      closeEventResponse: mockBatcherCloseEventHistory,
    });

    expect(mockGetHistory).toHaveBeenCalledWith({
      domain: 'cadence-batcher',
      workflowExecution: { workflowId: 'mock-batch-action-id-1', runId: '' },
      historyEventFilterType: 'EVENT_FILTER_TYPE_CLOSE_EVENT',
    });

    const body = await res.json();
    expect(body.status).toEqual('COMPLETED');
    expect(body.progress).toEqual({
      totalEstimate: MOCK_BATCH_PROGRESS.TotalEstimate,
      successCount: MOCK_BATCH_PROGRESS.SuccessCount,
      errorCount: MOCK_BATCH_PROGRESS.ErrorCount,
    });
  });

  it('returns 200 with undefined progress when the close-event read fails', async () => {
    const { res } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowCompleted,
      closeEventError: new Error('history unavailable'),
    });

    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(body.status).toEqual('COMPLETED');
    expect(body.progress).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Failed to read batch action progress from close event'
    );
  });

  it('populates last known progress from the activity timeout for a failed batch', async () => {
    const { res, mockGetHistory } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowFailed,
      fullHistoryResponse: mockBatcherActivityTimedOutHistory,
    });

    // Full history is fetched without a close-event filter and without pageSize.
    expect(mockGetHistory).toHaveBeenCalledWith({
      domain: 'cadence-batcher',
      workflowExecution: { workflowId: 'mock-batch-action-id-1', runId: '' },
    });

    const body = await res.json();
    expect(body.status).toEqual('FAILED');
    expect(body.progress).toEqual({
      totalEstimate: MOCK_BATCH_PROGRESS.TotalEstimate,
      successCount: MOCK_BATCH_PROGRESS.SuccessCount,
      errorCount: MOCK_BATCH_PROGRESS.ErrorCount,
    });
  });

  it('populates progress from the pending activity heartbeat for a failed batch that timed out at the workflow level', async () => {
    const { res, mockGetHistory } = await setup({
      describeResponse:
        mockDescribeBatchOperationWorkflowFailedWithPendingProgress,
    });

    const body = await res.json();
    expect(body.status).toEqual('FAILED');
    expect(body.progress).toEqual({
      totalEstimate: MOCK_BATCH_PROGRESS.TotalEstimate,
      successCount: MOCK_BATCH_PROGRESS.SuccessCount,
      errorCount: MOCK_BATCH_PROGRESS.ErrorCount,
    });

    // The pending heartbeat is enough, so only the input fetch hits getHistory.
    expect(mockGetHistory).toHaveBeenCalledTimes(1);
    expect(mockGetHistory).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 1 })
    );
  });

  it('leaves progress undefined for a failed batch that timed out at the workflow level', async () => {
    const { res } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowFailed,
      fullHistoryResponse: mockBatcherWorkflowTimedOutHistory,
    });

    const body = await res.json();
    expect(body.status).toEqual('FAILED');
    expect(body.progress).toBeUndefined();
  });

  it('returns 200 with undefined progress when the failed-batch history read fails', async () => {
    const { res } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowFailed,
      fullHistoryError: new Error('history unavailable'),
    });

    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(body.status).toEqual('FAILED');
    expect(body.progress).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Failed to read last batch action progress from history'
    );
  });

  it('returns 500 and logs when getHistory fails', async () => {
    const { res } = await setup({
      describeResponse: mockDescribeBatchOperationWorkflowCompleted,
      historyError: new Error('History service unavailable'),
    });

    expect(res.status).toEqual(500);
    expect(await res.json()).toEqual(
      expect.objectContaining({ message: 'Error fetching batch action' })
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        requestParams: {
          domain: 'mock-domain',
          cluster: 'mock-cluster',
          batchActionId: 'mock-batch-action-id-1',
        },
        error: expect.any(Error),
      }),
      'Error fetching batch action'
    );
  });

  it('returns 404 when the response is missing workflowExecutionInfo', async () => {
    const { res } = await setup({
      describeResponse: {
        ...mockDescribeBatchOperationWorkflowRunning,
        workflowExecutionInfo: null,
      },
    });

    expect(res.status).toEqual(404);
    expect(await res.json()).toEqual(
      expect.objectContaining({ message: 'Batch action not found' })
    );
  });

  it('returns 404 when describeWorkflow throws a NOT_FOUND GRPCError', async () => {
    const { res } = await setup({
      describeError: new GRPCError('Batcher workflow not found', {
        grpcStatusCode: status.NOT_FOUND,
      }),
    });

    expect(res.status).toEqual(404);
    expect(await res.json()).toEqual(
      expect.objectContaining({ message: 'Batcher workflow not found' })
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        requestParams: {
          domain: 'mock-domain',
          cluster: 'mock-cluster',
          batchActionId: 'mock-batch-action-id-1',
        },
        error: expect.any(GRPCError),
      }),
      'Error fetching batch action: Batcher workflow not found'
    );
  });

  it('returns 500 when describeWorkflow throws a generic error', async () => {
    const { res } = await setup({
      describeError: new Error('Network error'),
    });

    expect(res.status).toEqual(500);
    expect(await res.json()).toEqual(
      expect.objectContaining({ message: 'Error fetching batch action' })
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        requestParams: {
          domain: 'mock-domain',
          cluster: 'mock-cluster',
          batchActionId: 'mock-batch-action-id-1',
        },
        error: expect.any(Error),
      }),
      'Error fetching batch action'
    );
  });
});

async function setup({
  describeResponse,
  historyResponse = mockBatcherStartedHistory,
  closeEventResponse = EMPTY_HISTORY,
  fullHistoryResponse = EMPTY_HISTORY,
  describeError,
  historyError,
  closeEventError,
  fullHistoryError,
  batchActionId = 'mock-batch-action-id-1',
}: {
  describeResponse?: DescribeWorkflowExecutionResponse;
  historyResponse?: GetWorkflowExecutionHistoryResponse;
  closeEventResponse?: GetWorkflowExecutionHistoryResponse;
  fullHistoryResponse?: GetWorkflowExecutionHistoryResponse;
  describeError?: Error;
  historyError?: Error;
  closeEventError?: Error;
  fullHistoryError?: Error;
  batchActionId?: string;
}) {
  const mockDescribeWorkflow = jest
    .spyOn(mockGrpcClusterMethods, 'describeWorkflow')
    .mockImplementationOnce(async () => {
      if (describeError) throw describeError;
      return describeResponse!;
    });

  // The handler may call getHistory three ways: the started event for input
  // fields (pageSize 1), the close-event filter for final progress (COMPLETED),
  // and the full history for last progress (FAILED). Dispatch by the request
  // shape so every path is covered deterministically.
  const mockGetHistory = jest
    .spyOn(mockGrpcClusterMethods, 'getHistory')
    .mockImplementation(async (request) => {
      if (request.historyEventFilterType === 'EVENT_FILTER_TYPE_CLOSE_EVENT') {
        if (closeEventError) throw closeEventError;
        return closeEventResponse;
      }
      if (request.pageSize === 1) {
        if (historyError) throw historyError;
        return historyResponse;
      }
      if (fullHistoryError) throw fullHistoryError;
      return fullHistoryResponse;
    });

  const res = await describeBatchAction(
    new NextRequest('http://localhost'),
    {
      params: {
        domain: 'mock-domain',
        cluster: 'mock-cluster',
        batchActionId,
      },
    } as RequestParams,
    {
      grpcClusterMethods: mockGrpcClusterMethods,
    } as Context
  );

  return { res, mockDescribeWorkflow, mockGetHistory };
}

const EMPTY_HISTORY: GetWorkflowExecutionHistoryResponse = {
  history: { events: [] },
  archived: false,
  rawHistory: [],
  nextPageToken: '',
};
