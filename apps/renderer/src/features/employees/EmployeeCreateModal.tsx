import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import { Badge } from '../../components/ui';
import { useToast } from '../../components/Toast';
import type { EmployeeRow } from './api';
import {
  EMPTY_EMPLOYEE_FORM,
  EmploymentFields,
  FinanceFields,
  PersonFields,
  formToPayload,
  type EmployeeFormState,
} from './employeeForm';

const STEPS = [
  { key: 'person', label: '1. Person' },
  { key: 'employment', label: '2. Beschäftigung' },
  { key: 'finance', label: '3. Finanzen & Steuer' },
] as const;

export function EmployeeCreateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<EmployeeFormState>(EMPTY_EMPLOYEE_FORM);
  const set = (patch: Partial<EmployeeFormState>) => setForm((f) => ({ ...f, ...patch }));

  const create = useMutation({
    mutationFn: () => api.post<{ employee: EmployeeRow }>('/api/employees', formToPayload(form)),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['org'] });
      toast.success(`${res.employee.first_name} ${res.employee.last_name} wurde angelegt`);
      setForm(EMPTY_EMPLOYEE_FORM);
      setStep(0);
      onClose();
      navigate(`/personal/mitarbeitende/${res.employee.id}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const close = () => {
    setStep(0);
    onClose();
  };

  const personValid = form.first_name.trim() !== '' && form.last_name.trim() !== '';
  const isLast = step === STEPS.length - 1;

  return (
    <Modal
      title="Mitarbeiter:in anlegen"
      open={open}
      onClose={close}
      wide
      footer={
        <>
          {step > 0 && (
            <button className="hm-btn hm-btn--secondary" onClick={() => setStep(step - 1)}>
              Zurück
            </button>
          )}
          <button className="hm-btn hm-btn--secondary" onClick={close}>
            Abbrechen
          </button>
          {isLast ? (
            <button
              className="hm-btn hm-btn--primary"
              disabled={create.isPending || !personValid}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Wird angelegt…' : 'Anlegen'}
            </button>
          ) : (
            <button
              className="hm-btn hm-btn--primary"
              disabled={step === 0 && !personValid}
              onClick={() => setStep(step + 1)}
            >
              Weiter
            </button>
          )}
        </>
      }
    >
      <div className="row" style={{ marginBottom: 16 }}>
        {STEPS.map((s, i) => (
          <Badge key={s.key} tone={i === step ? 'blue' : i < step ? 'green' : 'neutral'}>
            {s.label}
          </Badge>
        ))}
      </div>
      {step === 0 && <PersonFields form={form} set={set} />}
      {step === 1 && <EmploymentFields form={form} set={set} />}
      {step === 2 && <FinanceFields form={form} set={set} />}
    </Modal>
  );
}
