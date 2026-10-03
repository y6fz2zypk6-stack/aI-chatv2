import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Persona } from '@shared/types';
import { api } from '../../api';
import { Avatar, RadioCard, RadioGroup } from '../../components';
import { Icon } from '../../icons';
import { Loading, Note, SettingsSubPage } from './parts';
import { useSettings } from './useSettings';

/** 新しい会話で最初に選ばれるペルソナ */
export default function DefaultPersonaPage() {
  const { settings, set } = useSettings();
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<Persona[]>('/personas').then(setPersonas).catch(() => setPersonas([]));
  }, []);

  if (!settings || !personas) return <Loading title="既定のペルソナ" />;
  const own = personas.find((p) => p.is_default === 1);

  return (
    <SettingsSubPage title="既定のペルソナ">
      <Note>新しい会話で、あなたとして使うペルソナ。シナリオで指定があれば、そちらが優先されます</Note>
      <RadioGroup label="既定のペルソナ">
        <RadioCard
          selected={settings.active_persona_id === ''}
          onSelect={() => void set({ active_persona_id: '' })}
          title="ペルソナ側の既定に従う"
        >
          {own ? `いまは「${own.name}」` : '既定のペルソナがありません'}
        </RadioCard>
        {personas.map((p) => (
          <RadioCard
            key={p.id}
            selected={settings.active_persona_id === p.id}
            onSelect={() => void set({ active_persona_id: p.id })}
            title={
              <>
                <Avatar className="rc-av" value={p.avatar} name={p.name} />
                {p.name}
              </>
            }
            tag={p.is_default === 1 ? '既定' : undefined}
          >
            {p.description ? <span className="clamp2">{p.description}</span> : undefined}
          </RadioCard>
        ))}
      </RadioGroup>
      <button className="link-row" onClick={() => navigate('/personas')}>
        ペルソナを編集する
        <Icon.chevR size={14} />
      </button>
    </SettingsSubPage>
  );
}
