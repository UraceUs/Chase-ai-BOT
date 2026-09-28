'use strict';

/**
 * Webhook do Kommo -> motor do SDR -> acoes no Kommo.
 *
 * Os funis sao os da equipe: Urace (pagina 1, recebe tudo) e Comercial
 * (pagina 2, so lead). Quem desce o card novo de uma pagina para a outra sao
 * as REGRAS 1 e 2 da propria equipe em Urace > First Contact. O SDR
 * complementa:
 *   - lead criado (leads[add]) em First Contact com cara de lixo (codigo de
 *     login, alerta de seguranca, notificacao): tag nao_e_lead antes dos
 *     5 min da REGRA 1, para o lixo nao ganhar DM e subir;
 *   - mensagem em First Contact: so tags (nao_e_lead, opt_out...); nao sobe
 *     o card, isso e da REGRA 2;
 *   - mensagem com sinal comercial num card enterrado (Urace > Cold Leads /
 *     Follow Up 1, ou fechado): sobe para Comercial > ENTRADA;
 *   - mensagem em card de outro funil (Contact list, Pos Venda...): nao
 *     move, mas avisa o responsavel com tarefa e nota;
 *   - card no Comercial: handoff (ATENDIMENTO + tarefa), opt-out e perdido,
 *     sempre para frente: o SDR nunca devolve card para etapa anterior.
 *
 * As respostas do robo ao lead continuam saindo pelo Salesbot, que chama
 * /api/sdr/avaliar. Aqui so se mexe no card.
 *
 * Modo 'observar' (padrao): calcula e registra no log o que faria, sem
 * escrever nada no Kommo. So 'aplicar' escreve.
 */

const sdr = require('../sdr');
const { PIPELINES, SLA } = require('../sdr/regras');

const TAG_BOT_SILENCIADO = 'sdr:bot-silenciado';
const MODOS = { OBSERVAR: 'observar', APLICAR: 'aplicar' };
const TIPO_TAREFA_CONTATO = 1;
// Motivos da triagem que marcam o card como nao-lead (nao_e_lead).
const MOTIVOS_NAO_LEAD = ['MENSAGEM_AUTOMATICA', 'SPAM_OU_OFERTA'];
// Um aviso de contato antigo por lead neste intervalo, por mais mensagens que cheguem.
const INTERVALO_AVISO_CONTATO_ANTIGO_MS = 24 * 60 * 60 * 1000;

function definirCaminho(alvo, partes, valor) {
  let atual = alvo;
  partes.forEach((parte, indice) => {
    if (indice === partes.length - 1) {
      atual[parte] = valor;
      return;
    }
    if (typeof atual[parte] !== 'object' || atual[parte] === null) {
      atual[parte] = {};
    }
    atual = atual[parte];
  });
}

/**
 * Converte o corpo x-www-form-urlencoded do Kommo (chaves com colchetes,
 * ex.: message[add][0][text]) em objeto. Aceita JSON tambem.
 */
function parseCorpoWebhook(bruto, contentType = '') {
  const texto = Buffer.isBuffer(bruto) ? bruto.toString('utf8') : String(bruto || '');
  if (!texto.trim()) {
    return {};
  }

  if (contentType.includes('application/json') || texto.trim().startsWith('{')) {
    return JSON.parse(texto);
  }

  const resultado = {};
  new URLSearchParams(texto).forEach((valor, chaveBruta) => {
    const partes = chaveBruta.replace(/\]/g, '').split('[').filter(parte => parte !== '');
    definirCaminho(resultado, partes, valor);
  });
  return resultado;
}

function canalPorOrigem(origem) {
  const valor = String(origem || '').toLowerCase();
  if (valor.includes('whats') || valor.includes('waba') || valor.includes('wa_')) return 'whatsapp';
  if (valor.includes('insta')) return 'instagram';
  if (valor.includes('facebook') || valor.includes('messenger') || valor === 'fb') return 'messenger';
  if (valor.includes('telegram')) return 'telegram';
  if (valor.includes('mail')) return 'email';
  return 'site';
}

/**
 * Mensagens recebidas (do lead) contidas no webhook.
 */
function extrairMensagensRecebidas(corpo) {
  const adicionadas = (corpo && corpo.message && corpo.message.add) || {};

  return Object.values(adicionadas)
    .filter(msg => msg && (!msg.type || msg.type === 'incoming'))
    .map(msg => {
      const tipoEntidade = String(msg.element_type || msg.entity_type || '');
      const ehLead = tipoEntidade === '2' || tipoEntidade === 'lead' || tipoEntidade === 'leads';
      return {
        id: msg.id || null,
        texto: msg.text || '',
        leadId: ehLead ? (msg.element_id || msg.entity_id || null) : null,
        contatoId: msg.contact_id || null,
        chatId: msg.chat_id || null,
        origem: msg.origin || null,
        midia: msg.attachment ? (msg.attachment.type || 'anexo') : null
      };
    });
}

/**
 * Leads criados contidos no webhook (evento add_lead).
 */
function extrairLeadsCriados(corpo) {
  const adicionados = (corpo && corpo.leads && corpo.leads.add) || {};

  return Object.values(adicionados)
    .filter(lead => lead && lead.id)
    .map(lead => ({
      id: String(lead.id),
      nome: lead.name || '',
      pipelineId: lead.pipeline_id || null,
      statusId: lead.status_id || null
    }));
}

function isoDeUnix(valor) {
  const numero = Number(valor);
  return numero > 0 ? new Date(numero * 1000).toISOString() : null;
}

function tagsDoLead(lead) {
  return ((lead && lead._embedded && lead._embedded.tags) || []).map(tag => tag.name);
}

function montarPayload(mensagem, lead, mapa, pipelineLogico) {
  const statusId = Number(lead.status_id);
  const local = mapa.localizar(lead.pipeline_id, statusId);

  return {
    canal: canalPorOrigem(mensagem.origem),
    tipo: 'mensagem',
    texto: mensagem.texto,
    midia: mensagem.texto ? mensagem.midia : (mensagem.midia || 'anexo'),
    origem: mensagem.origem,
    contato: { id: mensagem.contatoId ? String(mensagem.contatoId) : null },
    conversa: { id: mensagem.chatId },
    card: {
      existe: true,
      id: String(lead.id),
      pipeline: pipelineLogico || local.logico,
      estagio: mapa.nomeEtapa(lead.pipeline_id, statusId),
      status: local.fechado ? 'fechado' : 'aberto',
      botSilenciado: tagsDoLead(lead).includes(TAG_BOT_SILENCIADO),
      atualizadoEm: isoDeUnix(lead.updated_at),
      fechadoEm: isoDeUnix(lead.closed_at)
    }
  };
}

function textoDaNota(decisao) {
  const { kommo, robo } = decisao;
  const linhas = [`SDR: ${kommo.acao} (${kommo.motivo}) - ${kommo.descricao}`];

  if (kommo.destino && kommo.destino.mover) {
    linhas.push(`Destino: ${kommo.destino.pipeline} / ${kommo.destino.etapa}`);
  }

  const campos = Object.entries(kommo.campos || {}).map(([k, v]) => `${k}: ${v}`);
  if (campos.length > 0) {
    linhas.push(campos.join(' | '));
  }

  if (robo.escalonamento) {
    const esc = robo.escalonamento;
    linhas.push(`HANDOFF ${esc.prioridade.toUpperCase()}: ${esc.descricao}`);
    if (esc.resumo) {
      linhas.push(Object.entries(esc.resumo)
        .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n'));
    }
  }

  return linhas.join('\n');
}

/**
 * Aplica a decisao do motor a um lead. Devolve o que foi feito (para log).
 */
async function aplicarDecisao(cliente, lead, decisao, mapa, opcoes = {}) {
  const { kommo, robo } = decisao;
  const escrever = opcoes.modo === MODOS.APLICAR;
  const feito = {
    modo: escrever ? MODOS.APLICAR : MODOS.OBSERVAR,
    leadId: lead.id,
    acao: kommo.acao,
    motivo: kommo.motivo,
    moveu: false,
    tags: [],
    nota: false,
    tarefa: false
  };

  const atualizacao = {};
  const destino = kommo.destino || {};
  const entrada = mapa.pipelines[PIPELINES.ENTRADA];
  const saiDaEntrada = Boolean(entrada) && Number(lead.pipeline_id) === entrada.id;
  if (destino.mover && destino.etapa) {
    const statusId = mapa.statusId(destino.pipeline, destino.etapa);
    const pipelineId = mapa.pipelines[destino.pipeline] && mapa.pipelines[destino.pipeline].id;
    const mudaAlgo = statusId && pipelineId && (Number(lead.status_id) !== statusId || Number(lead.pipeline_id) !== pipelineId);

    // Card novo em First Contact nao sobe pelo SDR: quem sobe e a REGRA 2 da
    // equipe (+10 min). Subir antes faria o card pular a REGRA 1 (tag DM).
    const segurar = mudaAlgo && opcoes.segurarNaEntrada && destino.pipeline === PIPELINES.COMERCIAL;

    // Dentro do mesmo funil, o SDR so anda para frente: etapa anterior a
    // atual e trabalho do vendedor desfeito.
    const ordemAtual = mapa.ordemEtapa(lead.pipeline_id, lead.status_id);
    const ordemDestino = mapa.ordemEtapa(pipelineId, statusId);
    const volta = mudaAlgo && Number(lead.pipeline_id) === pipelineId
      && ordemAtual !== null && ordemDestino !== null && ordemDestino < ordemAtual;

    if (segurar) {
      feito.segurado = 'REGRA_2_DA_EQUIPE';
    } else if (volta) {
      feito.naoVoltou = { de: mapa.nomeEtapa(lead.pipeline_id, lead.status_id), para: destino.etapa };
    } else if (mudaAlgo) {
      atualizacao.pipeline_id = pipelineId;
      atualizacao.status_id = statusId;
      feito.moveu = { pipeline: destino.pipeline, etapa: destino.etapa };
    } else if (!statusId) {
      feito.aviso = `Etapa nao encontrada no Kommo: ${destino.pipeline} / ${destino.etapa}`;
    }
  }

  const tags = new Set([...(kommo.tags || []), ...mapa.tagsExtras(kommo.motivo)]);
  if (robo.escalonamento) {
    (robo.escalonamento.tags || []).forEach(tag => tags.add(tag));
  }
  if (robo.silenciarBot) {
    tags.add(TAG_BOT_SILENCIADO);
  }
  const existentes = tagsDoLead(lead);
  // Card que sobe da pagina 1 sem passar pela REGRA 1 recebe a tag de origem
  // que ela daria (DM), para os relatorios da equipe continuarem batendo.
  if (saiDaEntrada && feito.moveu && feito.moveu.pipeline === PIPELINES.COMERCIAL) {
    const origem = mapa.tagDeOrigemFaltando([...existentes, ...tags]);
    if (origem) {
      tags.add(origem);
    }
  }
  const novas = [...tags].filter(tag => !existentes.includes(tag));
  if (novas.length > 0) {
    atualizacao.tags_to_add = novas.map(name => ({ name }));
    feito.tags = novas;
  }

  if (escrever && Object.keys(atualizacao).length > 0) {
    await cliente.atualizarLead(lead.id, atualizacao);
  }

  // Nota so quando o card entra/volta ao Comercial ou vai para humano:
  // mensagem que so fica na Entrada nao polui o historico.
  const entrouNoComercial = ['criar_card', 'promover_card', 'reabrir_card'].includes(kommo.acao) && !feito.segurado;
  if (entrouNoComercial || robo.escalonamento) {
    if (escrever) {
      await cliente.adicionarNota(lead.id, textoDaNota(decisao));
    }
    feito.nota = true;
  }

  if (robo.escalonamento) {
    const agora = opcoes.agora || new Date();
    const prazoMinutos = (robo.escalonamento.tarefa && robo.escalonamento.tarefa.prazoMinutos) || 15;
    const tarefa = {
      text: robo.escalonamento.tarefa ? robo.escalonamento.tarefa.titulo : `SDR: ${robo.escalonamento.motivo}`,
      complete_till: Math.floor(agora.getTime() / 1000) + prazoMinutos * 60,
      entity_id: Number(lead.id),
      entity_type: 'leads',
      task_type_id: TIPO_TAREFA_CONTATO
    };
    const responsavel = Number(opcoes.responsavelId || lead.responsible_user_id);
    if (responsavel) {
      tarefa.responsible_user_id = responsavel;
    }
    if (escrever) {
      await cliente.criarTarefa(tarefa);
    }
    feito.tarefa = { prazoMinutos, prioridade: robo.escalonamento.prioridade };
  }

  return feito;
}

function textoDoAviso(decisao, lead, mapa) {
  return [
    `SDR: contato antigo voltou a falar com sinal comercial (${decisao.kommo.motivo}).`,
    `O card esta em ${mapa.nomeFunil(lead.pipeline_id)}; o SDR nao move cards deste funil.`,
    // Sem a linha "Destino": o card nao sai do lugar.
    textoDaNota({ ...decisao, kommo: { ...decisao.kommo, destino: null } })
  ].join('\n');
}

/**
 * Integracao completa: recebe o corpo do webhook e processa cada mensagem
 * e cada lead criado.
 */
function criarIntegracaoKommo({ cliente, obterMapa, responsavelId = null, modo = MODOS.OBSERVAR, log = console }) {
  const processadas = new Set();
  const avisados = new Map();
  const escrever = modo === MODOS.APLICAR;

  function jaProcessada(chaveEvento) {
    if (!chaveEvento) {
      return false;
    }
    if (processadas.has(chaveEvento)) {
      return true;
    }
    processadas.add(chaveEvento);
    if (processadas.size > 2000) {
      processadas.delete(processadas.values().next().value);
    }
    return false;
  }

  function avaliar(mensagem, lead, mapa, agora, pipelineLogico) {
    const payload = montarPayload(mensagem, lead, mapa, pipelineLogico);
    const erros = sdr.validarEvento(payload);
    if (erros.length > 0) {
      return { erros };
    }
    return { decisao: sdr.avaliarInteracao(payload, { agora }) };
  }

  /**
   * Card de funil que nao e do SDR (Contact list, Pos Venda...) recebeu
   * mensagem com sinal comercial: tarefa + nota para o responsavel, uma vez
   * por dia por lead. O card fica onde esta.
   */
  async function avisarContatoAntigo(lead, decisao, mapa, agora) {
    const ultimo = avisados.get(String(lead.id));
    if (ultimo && agora.getTime() - ultimo < INTERVALO_AVISO_CONTATO_ANTIGO_MS) {
      return { ignorado: 'AVISO_JA_ENVIADO', leadId: lead.id };
    }
    avisados.set(String(lead.id), agora.getTime());
    if (avisados.size > 2000) {
      avisados.delete(avisados.keys().next().value);
    }

    const prazoMinutos = SLA.tarefaHumanoMinutos;
    const tarefa = {
      text: `SDR: contato antigo voltou com sinal comercial (${decisao.kommo.motivo})`,
      complete_till: Math.floor(agora.getTime() / 1000) + prazoMinutos * 60,
      entity_id: Number(lead.id),
      entity_type: 'leads',
      task_type_id: TIPO_TAREFA_CONTATO
    };
    const responsavel = Number(responsavelId || lead.responsible_user_id);
    if (responsavel) {
      tarefa.responsible_user_id = responsavel;
    }

    if (escrever) {
      await cliente.adicionarNota(lead.id, textoDoAviso(decisao, lead, mapa));
      await cliente.criarTarefa(tarefa);
    }

    return {
      modo,
      leadId: lead.id,
      acao: 'avisar_contato_antigo',
      motivo: decisao.kommo.motivo,
      funil: mapa.nomeFunil(lead.pipeline_id),
      moveu: false,
      nota: true,
      tarefa: { prazoMinutos }
    };
  }

  async function processarMensagem(mensagem, agora = new Date()) {
    if (!mensagem.leadId) {
      return { ignorado: 'SEM_LEAD', mensagemId: mensagem.id };
    }
    if (jaProcessada(mensagem.id)) {
      return { ignorado: 'DUPLICADA', mensagemId: mensagem.id };
    }

    const mapa = await obterMapa();
    const lead = await cliente.obterLead(mensagem.leadId);
    const statusId = Number(lead.status_id);
    const local = mapa.localizar(lead.pipeline_id, statusId);

    // "Incoming leads" ainda nao aceito: o Kommo nao deixa mover por PATCH.
    if (local.incoming) {
      return { ignorado: 'INCOMING_LEADS', leadId: lead.id };
    }

    // Funil que nao e do SDR: avalia como se o card estivesse fora do
    // Comercial; com sinal comercial vira aviso, sem mover nada.
    if (!local.doSdr) {
      const { decisao, erros } = avaliar(mensagem, lead, mapa, agora, PIPELINES.ENTRADA);
      if (erros) {
        return { ignorado: 'EVENTO_INVALIDO', leadId: lead.id, erros };
      }
      if (!decisao.kommo.entraNoComercial) {
        return { ignorado: 'PIPELINE_FORA_DO_SDR', leadId: lead.id, pipelineId: lead.pipeline_id };
      }
      return avisarContatoAntigo(lead, decisao, mapa, agora);
    }

    const naPagina1 = local.logico === PIPELINES.ENTRADA;

    // Etapa da pagina 1 que nao e First Contact nem de resgate (Hot Leads,
    // Closing the sale...): a equipe esta trabalhando o card, o SDR nao mexe.
    if (naPagina1 && !local.fechado && !local.gerenciada && !local.resgate) {
      return { ignorado: 'ETAPA_DA_EQUIPE', leadId: lead.id, etapa: mapa.nomeEtapa(lead.pipeline_id, statusId) };
    }

    const { decisao, erros } = avaliar(mensagem, lead, mapa, agora);
    if (erros) {
      return { ignorado: 'EVENTO_INVALIDO', leadId: lead.id, erros };
    }

    // Card enterrado (resgate) ou fechado na pagina 1: so volta a andar se
    // for para subir ao Comercial.
    if (naPagina1 && (local.fechado || local.resgate) && !decisao.kommo.entraNoComercial) {
      return {
        ignorado: local.fechado ? 'FECHADO_SEM_SINAL' : 'RESGATE_SEM_SINAL',
        leadId: lead.id,
        motivo: decisao.kommo.motivo
      };
    }

    return aplicarDecisao(cliente, lead, decisao, mapa, {
      agora,
      responsavelId,
      modo,
      segurarNaEntrada: naPagina1 && local.gerenciada
    });
  }

  /**
   * Lead novo em First Contact com nome de lixo (assunto de e-mail de
   * sistema, notificacao): recebe nao_e_lead antes da REGRA 1 carimbar DM.
   * Qualquer outro lead novo e da equipe: nada a fazer.
   */
  async function processarLeadCriado(novo, agora = new Date()) {
    if (jaProcessada(`lead-${novo.id}`)) {
      return { ignorado: 'DUPLICADA', leadId: novo.id };
    }

    const mapa = await obterMapa();
    const lead = await cliente.obterLead(novo.id);
    const local = mapa.localizar(lead.pipeline_id, lead.status_id);
    if (local.logico !== PIPELINES.ENTRADA || !local.gerenciada || local.fechado) {
      return { ignorado: 'FORA_DE_FIRST_CONTACT', leadId: lead.id };
    }

    const texto = String(lead.name || novo.nome || '').trim();
    if (!texto) {
      return { ignorado: 'SEM_NOME', leadId: lead.id };
    }

    const decisao = sdr.avaliarInteracao({
      canal: 'email',
      tipo: 'mensagem',
      texto,
      card: { existe: true, id: String(lead.id), pipeline: PIPELINES.ENTRADA, status: 'aberto' }
    }, { agora });

    if (!MOTIVOS_NAO_LEAD.includes(decisao.kommo.motivo)) {
      return { ignorado: 'LEAD_DA_EQUIPE', leadId: lead.id };
    }

    const existentes = tagsDoLead(lead);
    const novas = [...new Set([...(decisao.kommo.tags || []), ...mapa.tagsExtras(decisao.kommo.motivo)])]
      .filter(tag => !existentes.includes(tag));
    if (escrever && novas.length > 0) {
      await cliente.atualizarLead(lead.id, { tags_to_add: novas.map(name => ({ name })) });
    }

    return { modo, leadId: lead.id, acao: 'marcar_nao_e_lead', motivo: decisao.kommo.motivo, tags: novas, moveu: false };
  }

  async function receberWebhook(corpo) {
    const resultados = [];

    for (const mensagem of extrairMensagensRecebidas(corpo)) {
      try {
        resultados.push(await processarMensagem(mensagem));
      } catch (error) {
        log.error('Kommo: falha ao processar mensagem', mensagem.id, error.message, error.detalhes || '');
        resultados.push({ erro: error.message, mensagemId: mensagem.id });
      }
    }

    for (const novo of extrairLeadsCriados(corpo)) {
      try {
        resultados.push(await processarLeadCriado(novo));
      } catch (error) {
        log.error('Kommo: falha ao processar lead criado', novo.id, error.message, error.detalhes || '');
        resultados.push({ erro: error.message, leadId: novo.id });
      }
    }

    resultados.forEach(r => log.log('Kommo SDR:', JSON.stringify(r)));
    return resultados;
  }

  return { receberWebhook, processarMensagem, processarLeadCriado };
}

module.exports = {
  TAG_BOT_SILENCIADO,
  MODOS,
  parseCorpoWebhook,
  extrairMensagensRecebidas,
  extrairLeadsCriados,
  canalPorOrigem,
  montarPayload,
  aplicarDecisao,
  criarIntegracaoKommo
};
