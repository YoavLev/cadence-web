import { styled as createStyled, type Theme } from 'baseui';
import { type ButtonOverrides } from 'baseui/button';
import { type ProgressBarOverrides } from 'baseui/progress-bar';

import { type BatchActionStatus } from '@/route-handlers/list-batch-actions/list-batch-actions.types';

import getStatusBackgroundColor from '../helpers/get-status-background-color';

export const overrides = {
  abortButton: {
    BaseButton: {
      style: ({ $theme }: { $theme: Theme }) => ({
        background: $theme.colors.negative,
      }),
    },
    StartEnhancer: {
      style: ({ $theme }: { $theme: Theme }) => ({
        fontSize: $theme.sizing.scale700,
      }),
    },
  } satisfies ButtonOverrides,
};

export function getProgressBarOverrides(
  status: BatchActionStatus
): ProgressBarOverrides {
  return {
    Label: {
      style: ({ $theme }: { $theme: Theme }) => ({
        ...$theme.typography.LabelMedium,
        color: $theme.colors.contentPrimary,
      }),
    },
    BarProgress: {
      style: ({ $theme }: { $theme: Theme }) => ({
        backgroundColor: getStatusBackgroundColor(status, $theme),
      }),
    },
  };
}

export const styled = {
  Container: createStyled('div', ({ $theme }: { $theme: Theme }) => ({
    display: 'flex',
    flexDirection: 'column' as const,
    gap: $theme.sizing.scale600,
    width: '100%',
  })),
  Header: createStyled('div', ({ $theme }: { $theme: Theme }) => ({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: $theme.sizing.scale600,
  })),
  Title: createStyled('h2', ({ $theme }: { $theme: Theme }) => ({
    ...$theme.typography.HeadingXSmall,
  })),
  ProgressSection: createStyled('div', ({ $theme }: { $theme: Theme }) => ({
    paddingTop: $theme.sizing.scale600,
  })),
};
