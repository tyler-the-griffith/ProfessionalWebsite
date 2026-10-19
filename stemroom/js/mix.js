// Pure mix rules: no AudioContext is needed to calculate or export a mix.
export const VOCAL = new Set(['lead', 'vocals', 'lead_dry']);
export const BACKING = new Set(['backing', 'backing_harmony', 'backing_other']);

export function playableStems(song) {
  // Complementary backing stems must both survive, even if one averages quiet.
  return (song?.stems || []).filter(s => !s.replacedBy && !(s.parent === 'drums' && s.quiet));
}

export function defaultStemMix(stem) {
  return { vol: 1, pan: 0, mute: stem.id === 'lead_dry', solo: false, reverb: 0, echo: 0, tone: 'natural',
    ...(stem.id === 'backing_harmony' ? { followLead: true } : {}) };
}

export function stemMix(stem, mix) {
  // Existing named mixes and queued snapshots only know the original backing
  // stem. Inherit its settings unless this child has been explicitly edited.
  const parent = stem.parent === 'backing' ? mix?.stems?.backing : null;
  return { ...defaultStemMix(stem), ...parent, ...mix?.stems?.[stem.id] };
}

export function leadVocalLevel(song, mix) {
  const leads = playableStems(song).filter(s => VOCAL.has(s.id));
  // A dry lead can be used instead of the original. Muting every lead also
  // silences the linked harmony; soloing a harmony still lets it be auditioned.
  return Math.max(0, ...leads.map(s => { const m = stemMix(s, mix); return m.mute ? 0 : m.vol; }));
}

/** Studio mix × performance settings -> the same gains for Stage, preview and export. */
export function computeGains(song, mix, entry, { karaoke = true } = {}) {
  const stems = playableStems(song);
  const anySolo = stems.some(s => stemMix(s, mix).solo);
  const leadLevel = leadVocalLevel(song, mix);
  const out = {};
  for (const s of stems) {
    const m = stemMix(s, mix);
    const linked = s.id === 'backing_harmony' && m.followLead !== false;
    let gain = linked ? leadLevel : m.vol;
    if (m.mute || (anySolo && !m.solo)) gain = 0;
    if (karaoke && entry) {
      if (VOCAL.has(s.id) || linked) gain *= entry.guide ?? 0.15;
      if (BACKING.has(s.id) && entry.backing === false) gain = 0;
    }
    out[s.id] = { gain, pan: m.pan, tone: m.tone, reverb: m.reverb, echo: m.echo };
  }
  return out;
}
