'use strict';

/**
 * Liga os destinos do motor (lib/sdr) aos funis e etapas reais do Kommo,
 * pelo mapa KOMMO_MAPA de lib/sdr/regras.js: Entrada = Urace (pagina 1),
 * Comercial = Comercial (pagina 2).
 *
 * Regra de seguranca: o SDR nao cria funil nem etapa. Os funis sao da
 * equipe; aqui so se confere se tudo que o mapa usa existe. O que faltar
 * volta como pendencia para corrigir o mapa ou o Kommo a mao.
 */

const { PIPELINES, ETAPAS_ENTRADA, ESTAGIOS, KOMMO_MAPA } = require('../sdr/regras');

const STATUS_GANHO = 142;
const STATUS_PERDIDO = 143;
const TIPO_INCOMING_LEADS = 1;

function chave(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function etapasLogicas(pipelineLogico) {
  return pipelineLogico === PIPELINES.ENTRADA ? Object.values(ETAPAS_ENTRADA) : Object.values(ESTAGIOS);
}

/** Etapas reais (texto, sem repetir) que um funil logico usa. */
function etapasReaisDe(logico, mapa) {
  const etapas = [];
  const incluir = real => {
    if (typeof real === 'string' && !etapas.some(e => chave(e) === chave(real))) {
      etapas.push(real);
    }
  };
  etapasLogicas(logico).forEach(etapa => incluir(mapa.etapas[etapa]));
  if (logico === PIPELINES.ENTRADA) {
    (mapa.etapasResgate || []).forEach(incluir);
  }
  return etapas;
}

/** Funis reais que o mapa usa, cada um com as etapas que precisam existir. */
function estruturaEsperada(mapa = KOMMO_MAPA) {
  const porNome = [];

  [PIPELINES.ENTRADA, PIPELINES.COMERCIAL].forEach(logico => {
    const nome = mapa.pipelines[logico];
    let funil = porNome.find(f => chave(f.nome) === chave(nome));
    if (!funil) {
      funil = { nome, logicos: [], etapas: [] };
      porNome.push(funil);
    }
    funil.logicos.push(logico);
    etapasReaisDe(logico, mapa).forEach(etapa => {
      if (!funil.etapas.some(e => chave(e) === chave(etapa))) {
        funil.etapas.push(etapa);
      }
    });
  });

  return porNome;
}

function etapasDoPipeline(pipeline) {
  return (pipeline && pipeline._embedded && pipeline._embedded.statuses) || [];
}

function acharPipeline(pipelinesKommo, nome) {
  return pipelinesKommo.find(p => chave(p.name) === chave(nome)) || null;
}

/**
 * Compara o mapa com o Kommo. Funil ou etapa faltando e erro de
 * configuracao: o SDR fica parado ate alguem corrigir, nunca cria sozinho.
 */
function planejarEstrutura(pipelinesKommo, mapa = KOMMO_MAPA) {
  const pipelinesFaltando = [];
  const etapasFaltando = [];
  const etapasDuplicadas = [];

  estruturaEsperada(mapa).forEach(esperado => {
    const existente = acharPipeline(pipelinesKommo, esperado.nome);
    if (!existente) {
      pipelinesFaltando.push({ nome: esperado.nome, etapas: esperado.etapas });
      return;
    }

    const nomes = etapasDoPipeline(existente).map(status => chave(status.name));
    esperado.etapas.forEach(etapa => {
      const ocorrencias = nomes.filter(nome => nome === chave(etapa)).length;
      if (ocorrencias === 0) {
        etapasFaltando.push({ pipeline: esperado.nome, etapa });
      } else if (ocorrencias > 1) {
        etapasDuplicadas.push({ pipeline: esperado.nome, etapa, ocorrencias });
      }
    });
  });

  return {
    ok: pipelinesFaltando.length === 0 && etapasFaltando.length === 0,
    pipelinesFaltando,
    etapasFaltando,
    // Etapa com nome repetido: o executor usa a primeira (menor ordem).
    etapasDuplicadas
  };
}

/**
 * Resolve ids <-> destinos logicos a partir dos funis do Kommo.
 */
function montarMapa(pipelinesKommo, mapa = KOMMO_MAPA) {
  const pipelines = {};

  [PIPELINES.ENTRADA, PIPELINES.COMERCIAL].forEach(logico => {
    const existente = acharPipeline(pipelinesKommo, mapa.pipelines[logico]);
    if (!existente) {
      return;
    }

    const etapas = {};
    const ordem = {};
    const incoming = [];
    etapasDoPipeline(existente)
      .slice()
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
      .forEach(status => {
        const id = Number(status.id);
        if (Number(status.type) === TIPO_INCOMING_LEADS) {
          incoming.push(id);
        }
        const k = chave(status.name);
        if (etapas[k] === undefined) {
          etapas[k] = id;
        }
        ordem[id] = Number(status.sort) || 0;
      });

    const idsDe = nomes => nomes.map(nome => etapas[chave(nome)]).filter(Boolean);

    pipelines[logico] = {
      id: Number(existente.id),
      nome: existente.name,
      etapas,
      ordem,
      incoming,
      // Etapas deste funil logico que o motor pode mover (as do mapa), por id.
      gerenciadas: idsDe(etapasReaisDe(logico, mapa).filter(nome => !(mapa.etapasResgate || []).includes(nome))),
      resgate: logico === PIPELINES.ENTRADA ? idsDe(mapa.etapasResgate || []) : []
    };
  });

  const logicosDoId = pipelineId => Object.keys(pipelines).filter(l => pipelines[l].id === Number(pipelineId));
  const nomesDosFunis = {};
  pipelinesKommo.forEach(p => { nomesDosFunis[Number(p.id)] = p.name; });

  return {
    pipelines,

    nomeFunil(pipelineId) {
      return nomesDosFunis[Number(pipelineId)] || String(pipelineId);
    },

    /**
     * Onde um card esta: zona logica ('Entrada'/'Comercial'), se esta em
     * Incoming leads, fechado, numa etapa que o motor gerencia ou numa etapa
     * de resgate da pagina 1. logico = null quando o funil nao e do SDR.
     */
    localizar(pipelineId, statusId) {
      const logicos = logicosDoId(pipelineId);
      const status = Number(statusId);
      const fechado = status === STATUS_GANHO || status === STATUS_PERDIDO;
      if (logicos.length === 0) {
        return { doSdr: false, logico: null, incoming: false, fechado, gerenciada: false, resgate: false };
      }

      const incoming = pipelines[logicos[0]].incoming.includes(status);
      const dono = logicos.find(l => pipelines[l].gerenciadas.includes(status));
      let logico = dono || null;
      if (!logico) {
        // Funil unico: fechado conta como Comercial (reabre/recebe anexo).
        // Funis separados: o funil ja diz a zona.
        logico = logicos.length === 1 ? logicos[0] : (fechado || incoming ? PIPELINES.COMERCIAL : null);
      }
      const resgate = logicos.some(l => pipelines[l].resgate.includes(status));

      return { doSdr: true, logico, incoming, fechado, gerenciada: Boolean(dono), resgate };
    },

    nomeEtapa(pipelineId, statusId) {
      const [logico] = logicosDoId(pipelineId);
      if (!logico) {
        return null;
      }
      const etapas = pipelines[logico].etapas;
      return Object.keys(etapas).find(k => etapas[k] === Number(statusId)) || null;
    },

    /**
     * Posicao da etapa no funil (sort do Kommo). Fechamentos (142/143) nao
     * tem posicao: devolve null.
     */
    ordemEtapa(pipelineId, statusId) {
      const [logico] = logicosDoId(pipelineId);
      const status = Number(statusId);
      if (!logico || status === STATUS_GANHO || status === STATUS_PERDIDO) {
        return null;
      }
      const ordem = pipelines[logico].ordem[status];
      return ordem === undefined ? null : ordem;
    },

    /** status_id real para um destino do motor. */
    statusId(pipelineLogico, etapaLogica) {
      const pipeline = pipelines[pipelineLogico];
      const real = mapa.etapas[etapaLogica];
      if (!pipeline || real === undefined) {
        return null;
      }
      if (typeof real === 'number') {
        return real;
      }
      return pipeline.etapas[chave(real)] || null;
    },

    tagsExtras(motivo) {
      return (mapa.tagsPorMotivo && mapa.tagsPorMotivo[motivo]) || [];
    },

    /** Tag que a REGRA 1 da equipe daria a um card sem tag de origem. */
    tagDeOrigemFaltando(tags) {
      const origem = mapa.tagsDeOrigem || [];
      if (!mapa.tagSemOrigem || origem.some(tag => tags.includes(tag))) {
        return null;
      }
      return mapa.tagSemOrigem;
    }
  };
}

/**
 * Confere o mapa contra o Kommo. Nunca escreve: os funis sao da equipe.
 */
async function sincronizarEstrutura(cliente, opcoes = {}) {
  const mapa = opcoes.mapa || KOMMO_MAPA;
  const pipelinesKommo = await cliente.listarPipelines();
  return {
    aplicado: false,
    plano: planejarEstrutura(pipelinesKommo, mapa),
    mapa: montarMapa(pipelinesKommo, mapa).pipelines
  };
}

/**
 * Mapa com cache: evita listar funis a cada mensagem recebida.
 */
function criarResolvedorDeMapa(cliente, ttlMs = 10 * 60 * 1000, mapa = KOMMO_MAPA) {
  let cache = null;
  let expiraEm = 0;

  return async function obterMapa(forcar = false) {
    const agora = Date.now();
    if (!forcar && cache && agora < expiraEm) {
      return cache;
    }
    cache = montarMapa(await cliente.listarPipelines(), mapa);
    expiraEm = agora + ttlMs;
    return cache;
  };
}

module.exports = {
  STATUS_GANHO,
  STATUS_PERDIDO,
  estruturaEsperada,
  planejarEstrutura,
  montarMapa,
  sincronizarEstrutura,
  criarResolvedorDeMapa
};
