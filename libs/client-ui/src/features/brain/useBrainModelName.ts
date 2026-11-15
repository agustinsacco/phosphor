import { recordedModelName, useModelCatalogueStore } from '@/stores/modelCatalogue'

export function useBrainModelName(model: string): string {
  return useModelCatalogueStore((s) => recordedModelName(s.models, model))
}
