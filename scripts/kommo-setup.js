#!/usr/bin/env node
'use strict';

/**
 * Confere no Kommo os funis e etapas que o SDR usa (Urace e Comercial, da
 * equipe) e registra o webhook. Nunca cria funil nem etapa.
 *
 *   KOMMO_SUBDOMINIO=urace KOMMO_TOKEN=... node scripts/kommo-setup.js
 *       so mostra o mapa e o que falta (nao altera nada)
 *   ... node scripts/kommo-setup.js --aplicar --webhook "https://<backend>/api/kommo/webhook?token=..."
 *       registra (ou completa) o webhook de mensagens e leads criados
 */

const kommo = require('../lib/kommo');

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const indiceWebhook = args.indexOf('--webhook');
  const webhookUrl = indiceWebhook >= 0 ? args[indiceWebhook + 1] : null;

  const integracao = kommo.criarIntegracaoDoAmbiente(process.env);
  if (!integracao) {
    console.error('Defina KOMMO_SUBDOMINIO e KOMMO_TOKEN.');
    process.exit(1);
  }

  const resultado = await integracao.sincronizarEstrutura();
  console.log(JSON.stringify(resultado, null, 2));

  if (!resultado.plano.ok) {
    console.log('\nO mapa aponta para funil ou etapa que nao existe no Kommo. Corrija KOMMO_MAPA');
    console.log('(lib/sdr/regras.js) ou o nome da etapa no Kommo; o SDR nao cria nada sozinho.');
  }

  if (aplicar && webhookUrl) {
    console.log('Webhook:', JSON.stringify(await integracao.registrarWebhook(webhookUrl)));
  }
}

main().catch(error => {
  console.error(error.message, error.detalhes ? JSON.stringify(error.detalhes) : '');
  process.exit(1);
});
