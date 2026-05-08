import { styled } from './domain-batch-actions-banner.styles';
import { type Props } from './domain-batch-actions-banner.types';

export default function DomainBatchActionsBanner({
  icon,
  children,
  action,
}: Props) {
  return (
    <styled.Banner>
      <styled.Content>
        <styled.IconContainer>{icon}</styled.IconContainer>
        {children}
      </styled.Content>
      {action}
    </styled.Banner>
  );
}
