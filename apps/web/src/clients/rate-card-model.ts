import type {
  ClientRateCard,
  ClientRateCardVersionInput,
  EffectiveClientRateCard,
  GeneralResource,
} from '@conflict-hq/ezacto-client'

export interface ClientRateCardApi {
  getClientRateCard?(id: number, signal?: AbortSignal): Promise<ClientRateCard>
  createClientRateCard?(id: number, name: string, signal?: AbortSignal): Promise<ClientRateCard>
  createClientRateCardVersion?(
    id: number,
    input: ClientRateCardVersionInput,
    signal?: AbortSignal,
  ): Promise<ClientRateCard>
  getClientEffectiveRateCard?(
    id: number,
    taskId: number,
    date: string,
    signal?: AbortSignal,
  ): Promise<EffectiveClientRateCard>
  listRateCardTasks?(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ data: readonly GeneralResource[]; page: { next_cursor: string | null } }>
}
