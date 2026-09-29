'use strict';

const cliente = require('./cliente');
const estrutura = require('./estrutura');
const webhook = require('./webhook');

// Eventos de webhook do Kommo: mensagem recebida e lead criado (este para
// marcar lixo do Inbox de e-mail antes da REGRA 1 da equipe).
const EVENTOS_WEBHOOK = ['add_message', 'add_lead'];

/**
 * Integracao a partir do ambiente, ou null quando o Kommo nao esta
 * configurado (KOMMO_SUBDOMINIO + KOMMO_TOKEN).
 */
function criarIntegracaoDoAmbiente(env = process.env, fetchImpl) {
  const clienteKommo = cliente.criarClienteKommoDoAmbiente(env, fetchImpl);
  if (!clienteKommo) {
    return null;
  }

  const integracao = webhook.criarIntegracaoKommo({
    cliente: clienteKommo,
    obterMapa: estrutura.criarResolvedorDeMapa(clienteKommo),
    responsavelId: env.KOMMO_RESPONSAVEL_ID || null,
    // So escreve no Kommo com KOMMO_MODO=aplicar; o padrao e observar.
    modo: env.KOMMO_MODO === webhook.MODOS.APLICAR ? webhook.MODOS.APLICAR : webhook.MODOS.OBSERVAR
  });

  return {
    cliente: clienteKommo,
    modo: env.KOMMO_MODO === webhook.MODOS.APLICAR ? webhook.MODOS.APLICAR : webhook.MODOS.OBSERVAR,
    ...integracao,
    sincronizarEstrutura: opcoes => estrutura.sincronizarEstrutura(clienteKommo, opcoes),
    async registrarWebhook(destino) {
      const existentes = await clienteKommo.listarWebhooks();
      const atual = existentes.find(w => w.destination === destino && !w.disabled);
      const eventosAtuais = (atual && atual.settings) || [];
      if (atual && EVENTOS_WEBHOOK.every(evento => eventosAtuais.includes(evento))) {
        return { registrado: false, motivo: 'JA_EXISTE' };
      }
      // Mesmo destino com eventos faltando (ex.: so add_message, de antes do
      // add_lead): o Kommo atualiza a assinatura existente.
      await clienteKommo.registrarWebhook(destino, EVENTOS_WEBHOOK);
      return { registrado: true, eventos: EVENTOS_WEBHOOK, atualizado: Boolean(atual) };
    }
  };
}

module.exports = {
  ...cliente,
  ...estrutura,
  ...webhook,
  EVENTOS_WEBHOOK,
  criarIntegracaoDoAmbiente
};
