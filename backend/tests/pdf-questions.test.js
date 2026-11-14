import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {answerPdfLocally} from '../local-document.js';
import {classifyPdfQuestion,answerVerifiedPdfQuestion,missingInformationSuggestions,pdfAnalysisPrompt,formatPdfAnalysis,pdfAnswerUsesKnownFigures} from '../pdf-questions.js';
const text=fs.readFileSync(new URL('./fixtures/sample-business-report.txt',import.meta.url),'utf8');
const doc={kind:'pdf',name:'TECHNOVALENS Sample Business Report',chunks:[text],pageCount:2,textLength:text.length};

test('PDF question classifier separates lookup, calculation, summary, comparison, reasoning and recommendations',()=>{
  for(const [question,category] of [['How many total orders were recorded during Q2?','factual'],['Calculate the average of monthly revenue','calculation'],['Summarize this report','summary'],['Compare Q1 and Q2 net profit','comparison'],['Why did profitability improve?','interpretation'],['What information is missing from this report?','recommendations'],['What recommendations does the report provide?','factual']])assert.equal(classifyPdfQuestion(question).category,category,question);
});
test('actual sample report table lookups return the right metric, period and verified page',()=>{
  const orders=answerPdfLocally(doc,'How many total orders were recorded during Q2?');assert.match(orders,/Orders: 930.*Page 1/i);assert.doesNotMatch(orders,/48,50,000/);
  const division=answerPdfLocally(doc,'Which business division had the highest gross margin?');assert.match(division,/Professional Services: 48%.*Page 1/i);
  const profit=answerPdfLocally(doc,'Compare Q1 and Q2 net profit');assert.match(profit,/Q1: n?6,30,000 versus Q2: n?8,25,000.*Page 2/i);assert.doesNotMatch(profit,/31\.0|15\.0|17\.0/);
  const recommendations=answerPdfLocally(doc,'What recommendations does the report provide?');assert.match(recommendations,/Increase marketing investment in Technology Products.*Page 2/);assert.match(recommendations,/delivery capacity/);assert.match(recommendations,/June's sales performance/);assert.match(recommendations,/Monitor operating expenses/);assert.doesNotMatch(recommendations,/delivered a positive Quarter/);
});
test('missing information and complex reasoning never return a retrieved conclusion as an answer',()=>{
  for(const question of ['What information is missing from this report?','What information is missing from this report that would help make better business decisions?','Evaluate the long term business implications','Why did profitability improve?'])assert.equal(answerPdfLocally(doc,question),null);
  const gaps=missingInformationSuggestions(doc);for(const term of ['Analytical suggestions','retention','profitability','marketing ROI','Regional','regional','cash flow','forecasts'].filter(term=>term!=='Regional'))assert.ok(gaps.includes(term),term);
  const amended={...doc,chunks:[text+'\nCustomer retention and marketing ROI are already measured.']};assert.doesNotMatch(missingInformationSuggestions(amended),/Consider adding customer retention|Consider adding marketing ROI/);
  assert.equal(answerPdfLocally(doc,'What is the report saying about kangaroo population?'),null);
  assert.equal(answerVerifiedPdfQuestion(doc,'How many total orders were recorded during Q1?'),null);
});
test('grounded PDF analysis rejects unsupported numbers, page references and fabricated source facts',()=>{
  const {prompt,evidence}=pdfAnalysisPrompt(doc,'What information is missing from this report?');assert.match(prompt,/not a copy of its conclusion/);assert.ok(evidence.length);
  const valid={sourceFacts:[{quote:'Professional Services had the highest gross',page:1}],analysis:['Margins suggest reviewing service capacity.'],analyticalSuggestions:['Consider measuring customer retention.']};
  assert.match(formatPdfAnalysis(JSON.stringify(valid),evidence),/Analytical suggestions \(not facts stated/);
  for(const invalid of [{...valid,sourceFacts:[{quote:'Invented revenue fact',page:1}]},{...valid,sourceFacts:[{quote:valid.sourceFacts[0].quote,page:99}]},{...valid,analyticalSuggestions:['Increase sales by 25%.']},{...valid,analysis:['See [Page 99]']},{}])assert.equal(formatPdfAnalysis(JSON.stringify(invalid),evidence),null);
  assert.equal(formatPdfAnalysis('Unrelated regional sales conclusion',evidence),null);
  assert.equal(pdfAnswerUsesKnownFigures('Professional Services: 48% [Page 1]',doc),true);
  assert.equal(pdfAnswerUsesKnownFigures('Revenue: 99999999 [Page 1]',doc),false);
  assert.equal(pdfAnswerUsesKnownFigures('Orders: 930 [Page 99]',doc),false);
  const unverified={...doc,chunks:[text.replace(/^Page [12]$/gm,'')]};assert.doesNotMatch(answerVerifiedPdfQuestion(unverified,'How many total orders were recorded during Q2?')||'',/\[Page/);
});
