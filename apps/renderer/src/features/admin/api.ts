import { useQuery } from '@tanstack/react-query';
import type { HrTemplate, OnboardingProcess, OnboardingTask } from '@ohrganize/shared';
import { api } from '../../api/client';

export function useHrTemplates(search: string, category: string) {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (category) params.set('category', category);
  const qs = params.toString();
  return useQuery({
    queryKey: ['admin', 'templates', search, category],
    queryFn: () => api.get<{ templates: HrTemplate[] }>(`/api/admin/templates${qs ? `?${qs}` : ''}`),
    select: (d) => d.templates,
  });
}

export function useOnboardingProcesses(status: string, kind: string) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (kind) params.set('kind', kind);
  const qs = params.toString();
  return useQuery({
    queryKey: ['admin', 'onboarding', status, kind],
    queryFn: () =>
      api.get<{ processes: OnboardingProcess[] }>(`/api/admin/onboarding${qs ? `?${qs}` : ''}`),
    select: (d) => d.processes,
  });
}

export function useOnboardingProcess(id: number | null) {
  return useQuery({
    queryKey: ['admin', 'onboarding', 'detail', id],
    queryFn: () =>
      api.get<{ process: OnboardingProcess; tasks: OnboardingTask[] }>(`/api/admin/onboarding/${id}`),
    enabled: id !== null,
  });
}
