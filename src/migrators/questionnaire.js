
const { getAllQuestionnaires, getGroupedQuestions, getGroupedResponses, getGroupedLoincCodes } = require('../sql');

function buildQuestionnaire(profileUrl, serverUrl, {
  asmtid, version, status, date, name, description, title, publisher, startdate, enddate, approvaldate
}) {
  const resource = {
    resourceType: 'Questionnaire',
    id: asmtid,
    url: `${serverUrl}/Questionnaire/${asmtid}`,
    meta: {
      profile: `${profileUrl}/StructureDefinition/del-StandardForm`
    },
    text: {
      status: 'generated',
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${name} standard form version ${version}.<br/><br/>${description}</div>`
    },
    status, // active, draft, retired
    date, // date last changed
    name,
    version,
    publisher,
    title,
    description,
    effectivePeriod: { start: startdate }
  };

  if (approvaldate) {
    resource.approvalDate = approvaldate;
  }

  if (enddate && enddate > startdate) {
    resource.effectivePeriod.end = enddate;
  }

  return resource;
}

function buildQuestion({ datatype, label, sectionid, text, typename, maxlength }, responses, loincs) {
  let type = 'group';
  if (datatype === 'character') type = 'text';
  if (datatype === 'number') type = 'integer';
  if (datatype === 'date') type = 'open-choice';

  const item = {
    linkId: `Section-${sectionid}/${label}`,
    prefix: label,
    text: text.trim(),
    type,
    repeats: typename == 'checklist',
    readOnly: type === 'group',
  };

  if (loincs && loincs.length) {
    // If it exists, it should be an array with only one item.
    const loinc = loincs[0];
    item.code = [{
      system: `https://details.loinc.org/LOINC/${loinc.loinccode}.html#${loinc.latestversion}`
    }];
  }

  if (responses) {
    // Filter by only responses that are not blank.
    const answerOptions = responses.filter(resp => resp.responsecode).map(resp => {
      return {
        valueCoding: {
          code: resp.responsecode,
          display: resp.responsetext,
        }
      };
    });
    if (answerOptions.length) {
      item.answerOption = answerOptions;
    }
  }

  if (item.answerOption) {
    // For text and integer fields, then we can set it to choice mode if there are choices.
    if (item.type === 'text' || item.type === 'integer') {
      item.type = 'choice';
    }

    // If it's a choice field and there are min/max options, change to open choice.
    const valueOptions = item.answerOption.filter(option => {
      return ['Minimum value', 'Maximum value'].includes(option.valueCoding.display);
    });
    if (valueOptions.length) {
      item.type = 'open-choice';
    }

    // If it's a choice field and there are options of either Text or ICD,
    // change to open choice and remove those options.
    const textOptions = item.answerOption.filter(option => {
      return ['Text', 'ICD'].includes(option.valueCoding.code);
    });

    if (textOptions.length) {
      item.type = 'open-choice';
      item.answerOption = item.answerOption.filter(option => {
        return !(['Text', 'ICD'].includes(option.valueCoding.code));
      });
    }
  }

  // If it's choice or open choice and there are no options, make it text.
  if (['choice', 'open-choice'].includes(item.type) && item.answerOption && !item.answerOption.length) {
    item.type = 'text';
    delete item.answerOption;
  }

  if (maxlength && !['choice', 'open-choice'].includes(item.type)) {
    item.maxLength = maxlength;
  }

  return item;
}

function applyQuestions(resource, questions, responses, loincs) {
  if (!questions) {
    return;
  }

  loincs = loincs || {};

  const questionMap = {};
  const sectionMap = {};

  for (const question of questions) {
    // Check to see if we already have this section.
    // Create a new one if not.
    if (!sectionMap[question.sectionid]) {
      sectionMap[question.sectionid] = {
        linkId: `Section-${question.sectionid}`,
        text: question.sectionname.trim(),
        type: 'group',
        readOnly: true,
        item: []
      };
    }
    const section = sectionMap[question.sectionid];

    // This is a root question or section. Place directly in the section.
    if (!question.parentid) {
      const item = buildQuestion(question, responses[question.questionid], loincs[question.questionid]);
      questionMap[question.questionid] = item;
      section.item.push(item);
      continue;
    }

    // Otherwise we need to find the parent!
    const parent = questionMap[question.parentid];

    // If parent is not found, skip!
    if (!parent) {
      continue;
    }

    // Make sure parent has items array.
    if (!parent.item) {
      parent.item = [];
    }

    // Then add this question to parent.
    const newQuestion = buildQuestion(question, responses[question.questionid], loincs[question.questionid]);
    parent.item.push(newQuestion);
  }

  // Finally push each section to the questionnaire.
  resource.item = [];
  for (const section of Object.values(sectionMap)) {
    resource.item.push(section);
  }
}

/**
 * Build all questionnaires and return then as a list of objects.
 *
 * @param {String} profileUrl
 * @param {String} serverUrl
 * @param {import('pg').Client} client
 */
async function run(profileUrl, serverUrl, client) {
  const questionnaireResults = await getAllQuestionnaires(client);
  const groupedQuestions = await getGroupedQuestions(client, ['asmtid']);
  const responseMap = await getGroupedResponses(client, ['asmtid', 'questionid']);
  const loincMap = await getGroupedLoincCodes(client, ['asmtid', 'questionid']);

  const output = [];

  for (const row of questionnaireResults) {
    const questionnaire = buildQuestionnaire(profileUrl, serverUrl, row);

    applyQuestions(
      questionnaire,
      groupedQuestions[questionnaire.id],
      responseMap[questionnaire.id],
      loincMap[questionnaire.id]
    );

    output.push(questionnaire);
  }

  return output;
}

module.exports = { run };
