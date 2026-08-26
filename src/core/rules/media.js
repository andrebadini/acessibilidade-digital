import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { createRuleRegistry } from './registry.js';
import {
  attribute,
  documentTarget,
  hasAttribute,
  hasOwn,
  isHidden,
  missingSnapshotResult,
  normalizeText,
  orderTargets,
  result,
  snapshotParts,
  tagOf,
  target
} from './snapshot.js';

function definition(id, evaluate) {
  const items = NBR17225_ITEMS.filter(item => item.ruleIds.includes(id));
  if (items.length === 0) throw new TypeError(`Regra ausente do catálogo NBR: ${id}`);
  return {
    id,
    mode: items[0].evaluation,
    nbrItems: items.map(item => item.id),
    wcag: [...new Set(items.flatMap(item => item.wcag.map(reference => reference.id)))],
    evaluate
  };
}

function mediaResult(snapshot, evaluate) {
  const parts = snapshotParts(snapshot);
  if (!parts) return missingSnapshotResult();
  const value = evaluate(parts);
  return { ...value, targets: orderTargets(value.targets, parts.nodes) };
}

function images(nodes) {
  return nodes.filter(node => !isHidden(node) && (
    ['img', 'area'].includes(tagOf(node)) ||
    (tagOf(node) === 'input' && normalizeText(attribute(node, 'type')).toLowerCase() === 'image') ||
    node?.imageCandidate === true
  ));
}

function mediaPurpose(node) {
  return normalizeText(node?.mediaPurpose).toLowerCase();
}

const IMAGE_RULE_PURPOSE = Object.freeze({
  'content-image-alternative': 'content',
  'functional-image-alternative': 'functional',
  'decorative-image-alternative': 'decorative',
  'complex-image-description': 'complex',
  'images-of-text': 'text',
  'image-map-alternative': 'image-map'
});

function alternativeValue(node) {
  if (hasAttribute(node, 'alt')) return { known: true, value: attribute(node, 'alt') ?? '' };
  if (hasOwn(node, 'accessibleName')) return { known: true, value: node.accessibleName };
  return { known: false, value: '' };
}

function imageAlternative(snapshot, ruleId) {
  const expectedPurpose = IMAGE_RULE_PURPOSE[ruleId];
  return mediaResult(snapshot, ({ nodes }) => {
    const candidates = images(nodes);
    if (candidates.length === 0) return result('inapplicable', 'Não há imagens aplicáveis.');
    const applicable = candidates.filter(node => mediaPurpose(node) === expectedPurpose);
    const unknown = candidates.filter(node => !mediaPurpose(node) || mediaPurpose(node) === 'unknown');
    if (applicable.length === 0 && unknown.length === 0) return result('inapplicable', 'Não há imagens desta finalidade observável.');
    const failures = [];
    for (const node of applicable) {
      const alternative = alternativeValue(node);
      if (expectedPurpose === 'decorative') {
        if (!alternative.known || normalizeText(alternative.value)) {
          failures.push(target(node, 'Remova a alternativa textual de uma imagem confirmada como decorativa.', {
            reason: alternative.known ? 'decorative-alternative-not-empty' : 'missing-decorative-empty-alternative'
          }));
        }
      } else if (ruleId !== 'images-of-text' && (!alternative.known || !normalizeText(alternative.value))) {
        failures.push(target(node, 'Forneça uma alternativa textual não vazia para esta imagem.', {
          reason: 'missing-alternative'
        }));
      }
    }
    if (failures.length > 0) return result('failed', 'Há imagem com alternativa objetivamente ausente ou incompatível com a finalidade declarada.', failures);
    const review = [...applicable, ...unknown].map(node => target(node, 'Confirme a finalidade da imagem e a equivalência de sua alternativa.', {
      reason: unknown.includes(node) ? 'unknown-image-purpose' : 'verify-alternative-quality',
      declaredPurpose: mediaPurpose(node) || 'unknown'
    }));
    return result('cantTell', 'A presença objetiva foi verificada; finalidade e equivalência exigem revisão humana.', review, [
      'Compare a informação, função ou decoração visível com a alternativa disponível.'
    ]);
  });
}

function audioControl(snapshot) {
  return mediaResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node =>
      !isHidden(node) && ['audio', 'video'].includes(tagOf(node)) && node?.autoplay === true
    );
    if (candidates.length === 0) return result('inapplicable', 'Não há áudio iniciado automaticamente.');
    const failures = [];
    let incomplete = false;
    let applicable = false;
    for (const node of candidates) {
      if (tagOf(node) === 'video' && node.hasAudio !== true) {
        if (
          node.hasAudio !== false && node.muted !== true &&
          (!Number.isFinite(node.durationSeconds) || node.durationSeconds > 3)
        ) incomplete = true;
        continue;
      }
      applicable = true;
      if (!Number.isFinite(node.durationSeconds)) {
        incomplete = true;
        continue;
      }
      if (node.durationSeconds < 0) {
        incomplete = true;
        continue;
      }
      if (node.durationSeconds <= 3 || node.muted === true) continue;
      const control = node.audioControl;
      if (!control || typeof control !== 'object') {
        incomplete = true;
      } else if ([control.canPause, control.canStop, control.independentVolume].some(value => value === true)) {
        continue;
      } else if (
        ['canPause', 'canStop', 'independentVolume'].every(field =>
          hasOwn(control, field) && control[field] === false
        )
      ) {
        failures.push(target(node, 'Forneça pausa, parada ou volume independente para este áudio automático.', {
          reason: 'missing-autoplay-audio-control', durationSeconds: node.durationSeconds
        }));
      } else {
        incomplete = true;
      }
    }
    if (failures.length > 0) return result('failed', 'Há áudio automático acima de três segundos sem controle adequado.', failures);
    if (incomplete) return result('cantTell', 'A duração ou os controles do áudio automático não foram coletados.', [], [
      'Observe a duração efetiva e a disponibilidade de pausa, parada ou volume independente.'
    ]);
    if (!applicable) return result('inapplicable', 'Não há áudio iniciado automaticamente de forma conclusiva.');
    return result('passed', 'Todo áudio automático observado dura até três segundos ou oferece controle adequado.');
  });
}

function videoCaptions(snapshot) {
  return mediaResult(snapshot, ({ nodes }) => {
    const videos = nodes.filter(node => !isHidden(node) && tagOf(node) === 'video' && node?.mediaTiming === 'prerecorded');
    if (videos.length === 0) return result('inapplicable', 'Não há vídeo pré-gravado com áudio aplicável.');
    const failures = [];
    const review = [];
    let incomplete = false;
    let applicable = false;
    for (const node of videos) {
      if (node.hasAudio === false) continue;
      if (node.hasAudio !== true) {
        incomplete = true;
        review.push(target(node, 'Determine se este vídeo possui áudio antes de concluir a exigência de legendas.', { reason: 'unknown-video-audio' }));
        continue;
      }
      applicable = true;
      if (node.essentiality !== 'non-essential') {
        incomplete = true;
        review.push(target(node, 'Determine a finalidade da mídia antes de concluir a exigência de legendas.', { reason: 'unknown-media-essentiality' }));
        continue;
      }
      if (!Array.isArray(node.captionTracks)) {
        incomplete = true;
        review.push(target(node, 'Colete as faixas de texto deste vídeo antes de concluir a presença de legendas.', {
          reason: 'missing-captions-observation'
        }));
      } else if (node.captionTracks.length === 0) {
        failures.push(target(node, 'Forneça uma faixa de legendas para este vídeo pré-gravado com áudio.', { reason: 'missing-captions-track' }));
      } else {
        const validTracks = node.captionTracks.filter(track =>
          track && typeof track === 'object' && !Array.isArray(track) &&
          typeof track.kind === 'string' && normalizeText(track.kind)
        );
        const captions = validTracks.filter(track =>
          normalizeText(track.kind).toLowerCase() === 'captions' && normalizeText(track.srclang)
        );
        if (captions.length > 0) {
          review.push(target(node, 'Compare as legendas com todo o conteúdo sonoro relevante.', { reason: 'verify-caption-equivalence' }));
        } else if (validTracks.length !== node.captionTracks.length ||
          validTracks.some(track => normalizeText(track.kind).toLowerCase() === 'captions')) {
          incomplete = true;
          review.push(target(node, 'Complete os metadados da faixa antes de verificar as legendas.', { reason: 'malformed-captions-track' }));
        } else {
          failures.push(target(node, 'Forneça uma faixa de legendas para este vídeo pré-gravado com áudio.', { reason: 'missing-captions-track' }));
        }
      }
    }
    if (failures.length > 0) return result('failed', 'Há vídeo pré-gravado com áudio sem faixa de legendas.', failures);
    if (review.length > 0) return result('cantTell', 'Há faixa ou contexto de legendas que exige revisão humana.', review, [
      'Confirme sincronização, identificação de falantes e equivalência de fala e sons relevantes.'
    ]);
    if (incomplete) return result('cantTell', 'A coleta de faixas de legendas está incompleta.', [], ['Colete as faixas de texto do vídeo.']);
    if (!applicable) return result('inapplicable', 'Os vídeos pré-gravados observados não possuem áudio.');
    return result('cantTell', 'A equivalência das legendas exige revisão humana.', [], ['Compare as legendas com o áudio.']);
  });
}

const REVIEW_MEDIA_CONFIG = Object.freeze({
  'audio-text-alternative': { timing: 'prerecorded', tags: ['audio'], request: 'Compare a alternativa textual com todo o áudio pré-gravado.' },
  'video-transcript': { timing: 'prerecorded', tags: ['video'], request: 'Compare a transcrição com as informações visuais e sonoras do vídeo.' },
  'video-audio-description': { timing: 'prerecorded', tags: ['video'], request: 'Verifique se a audiodescrição comunica as informações visuais necessárias.' },
  'extended-audio-description': { timing: 'prerecorded', tags: ['video'], request: 'Verifique se pausas e audiodescrição estendida cobrem todas as informações visuais.' },
  'sign-language-interpretation': { timing: 'prerecorded', tags: ['audio', 'video'], request: 'Verifique a equivalência e legibilidade da interpretação em Libras.' },
  'low-background-audio': { timing: 'prerecorded', tags: ['audio', 'video'], request: 'Meça ou compare o áudio de fundo com a fala principal.' },
  'live-captions': { timing: 'live', tags: ['audio', 'video'], request: 'Observe a transmissão e confirme legendas ao vivo equivalentes.' },
  'live-audio-transcript': { timing: 'live', tags: ['audio', 'video'], request: 'Observe a transmissão e confirme uma alternativa textual ao vivo equivalente.' }
});

function mediaReview(snapshot, ruleId) {
  const config = REVIEW_MEDIA_CONFIG[ruleId];
  return mediaResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node => !isHidden(node) && config.tags.includes(tagOf(node)) && node?.mediaTiming === config.timing);
    if (candidates.length === 0) return result('inapplicable', 'Não há mídia desta categoria no estado observado.');
    return result('cantTell', 'A alternativa de mídia exige comparação humana.', candidates.map(node =>
      target(node, config.request, { reason: 'verify-media-equivalence' })
    ), [config.request]);
  });
}

function animationControl(snapshot) {
  return mediaResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node => !isHidden(node) && Array.isArray(node?.animations) && node.animations.length > 0);
    if (candidates.length === 0) return result('inapplicable', 'Não há animação CSS observada.');
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      for (const animation of node.animations) {
        const validIterations = animation && (
          animation.iterationCount === Infinity ||
          (Number.isFinite(animation.iterationCount) && animation.iterationCount > 0)
        );
        if (!animation || !Number.isFinite(animation.durationSeconds) ||
          animation.durationSeconds <= 0 || !validIterations) {
          incomplete = true;
          continue;
        }
        const totalDurationSeconds = animation.durationSeconds * animation.iterationCount;
        if (totalDurationSeconds <= 5) continue;
        const controls = [animation.hasPauseControl, animation.hasStopControl, animation.hasHideControl];
        if (controls.some(value => value === true)) continue;
        if (animation.essentiality === 'essential') continue;
        if (animation.essentiality !== 'non-essential') {
          incomplete = true;
          continue;
        }
        if (controls.every(value => value === false)) {
          failures.push(target(node, 'Forneça controle para pausar, parar ou ocultar esta animação.', {
            reason: 'missing-animation-control', durationSeconds: animation.durationSeconds,
            iterationCount: animation.iterationCount, totalDurationSeconds
          }));
        } else {
          incomplete = true;
        }
      }
    }
    if (failures.length > 0) return result('failed', 'Há animação prolongada sem controle.', failures);
    if (incomplete) return result('cantTell', 'Duração, repetição ou essencialidade da animação não foi determinada.', [], [
      'Colete duração, repetição, controle disponível e essencialidade de cada animação.'
    ]);
    return result('passed', 'As animações observadas são breves, essenciais ou controláveis.');
  });
}

function interactionAnimation(snapshot) {
  return mediaResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node => !isHidden(node) && Array.isArray(node?.animations) &&
      node.animations.some(animation => animation?.triggeredByInteraction === true));
    if (candidates.length === 0) return result('inapplicable', 'Não há animação acionada por interação observada.');
    const failures = [];
    const review = [];
    for (const node of candidates) {
      for (const animation of node.animations.filter(value => value?.triggeredByInteraction === true)) {
        if (animation.respectsReducedMotion === false && animation.essentiality === 'non-essential') {
          failures.push(target(node, 'Permita desabilitar esta animação de interação por preferência de movimento reduzido.', {
            reason: 'reduced-motion-not-respected'
          }));
        } else {
          review.push(target(node, 'Confirme se esta animação pode ser desabilitada e se é essencial.', {
            reason: animation.respectsReducedMotion === true
              ? 'reduced-motion-mechanism-observed'
              : 'verify-interaction-animation'
          }));
        }
      }
    }
    if (failures.length > 0) return result('failed', 'Há animação de interação não essencial que ignora movimento reduzido.', failures);
    return result('cantTell', 'A necessidade da animação de interação exige revisão humana.', review, [
      'Avalie finalidade, preferência de movimento reduzido e efeito vestibular da animação.'
    ]);
  });
}

function flashing(snapshot, enhanced) {
  return mediaResult(snapshot, ({ document }) => {
    if (!hasOwn(document, 'flashObservation')) return result('cantTell', 'A frequência de flashes não foi medida.', [], [
      'Execute medição temporal e espacial confiável do conteúdo intermitente.'
    ]);
    const observation = document.flashObservation;
    if (!observation || observation.reliable !== true) return result('cantTell', 'A medição de flashes não é confiável.', [], [
      'Use amostragem de pixels com frequência suficiente e registre a área crítica.'
    ]);
    if (enhanced) {
      if (!Number.isFinite(observation.flashesPerSecond) || observation.flashesPerSecond < 0) return result('cantTell', 'A frequência de flashes não foi calculada.', [], ['Calcule flashes por segundo.']);
      return observation.flashesPerSecond > 3
        ? result('failed', 'O conteúdo excede três flashes por segundo.', [documentTarget(document, 'Reduza a frequência para no máximo três flashes por segundo.', { reason: 'flash-rate-exceeded', flashesPerSecond: observation.flashesPerSecond })])
        : result('passed', 'A medição confiável não excede três flashes por segundo.');
    }
    if (typeof observation.withinGeneralThreshold !== 'boolean') return result('cantTell', 'O limiar geral de flash não foi calculado.', [], ['Calcule frequência, luminância, cor e área de flash.']);
    return observation.withinGeneralThreshold
      ? result('passed', 'O conteúdo medido permanece no limiar geral de flash.')
      : result('failed', 'O conteúdo excede o limiar geral de flash.', [documentTarget(document, 'Reduza frequência, intensidade ou área do conteúdo intermitente.', { reason: 'general-flash-threshold-exceeded' })]);
  });
}

function updatingContent(snapshot) {
  return mediaResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node => !isHidden(node) && node?.updatingContent?.startsAutomatically === true);
    if (candidates.length === 0) return result('inapplicable', 'Não há conteúdo atualizado automaticamente observado.');
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      const observation = node.updatingContent;
      if (!Number.isFinite(observation.durationSeconds) || observation.durationSeconds < 0) incomplete = true;
      else if (observation.durationSeconds <= 5 || observation.essentiality === 'essential' || observation.hasPauseControl === true) continue;
      else if (observation.essentiality !== 'non-essential') incomplete = true;
      else failures.push(target(node, 'Forneça controle para pausar, parar ou ocultar esta atualização.', { reason: 'missing-updating-content-control' }));
    }
    if (failures.length > 0) return result('failed', 'Há atualização automática prolongada sem controle.', failures);
    if (incomplete) return result('cantTell', 'Duração, essencialidade ou controle da atualização não foi determinado.', [], [
      'Observe a atualização e registre duração, essencialidade e controle.'
    ]);
    return result('passed', 'As atualizações observadas são breves, essenciais ou controláveis.');
  });
}

export const MEDIA_RULES = createRuleRegistry([
  ...Object.keys(IMAGE_RULE_PURPOSE).map(id => definition(id, snapshot => imageAlternative(snapshot, id))),
  ...Object.keys(REVIEW_MEDIA_CONFIG).map(id => definition(id, snapshot => mediaReview(snapshot, id))),
  definition('video-captions', videoCaptions),
  definition('audio-control', audioControl),
  definition('animation-control', animationControl),
  definition('interaction-animation', interactionAnimation),
  definition('flashing-content-enhanced', snapshot => flashing(snapshot, true)),
  definition('flashing-content-limit', snapshot => flashing(snapshot, false)),
  definition('updating-content-control', updatingContent)
]);
