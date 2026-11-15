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
import {getHttpStatus,isDailyGeminiQuotaError,userFacingGeminiError} from '../gemini-errors.js';
import {normalizePdfQuestion} from '../pdf-questions.js';

test('informal division questions use deterministic PDF values and comparisons',()=>{
  for(const question of ['can you explain abt division performance','pls compare divisions','how are divisions doing?','Explain business division results']){
    const answer=answerPdfLocally(doc,question);
    assert.match(answer,/Technology Products: Q2 Revenue: 22,50,000; Share of Revenue: 46.4%; Gross Margin: 32%.*Page 1/);
    assert.match(answer,/Professional Services: Q2 Revenue: 15,00,000; Share of Revenue: 30.9%; Gross Margin: 48%.*Page 1/);
    assert.match(answer,/Accessories: Q2 Revenue: 11,00,000/);
    assert.match(answer,/Calculated Q2 Revenue gap.*1,150,000.*Page 1/);
    assert.match(answer,/23 percentage points.*Page 1/);
    assert.match(answer,/Missing division metrics: profit/);
    assert.doesNotMatch(answer,/Page 2|daily limit/);
  }
  assert.equal(normalizePdfQuestion('pls explain abt divisions'),'please explain about division');
});

test('division results are extracted rather than hardcoded and pages cannot be invented',()=>{
  const changed={...doc,chunks:[text.replace(/Page 1/g,'Page 4').replace('n22,50,000','n10,00,000').replace('32%','52%')],pageCount:4};
  const answer=answerPdfLocally(changed,'compare division performance');
  assert.match(answer,/Q2 Revenue: Professional Services leads/);
  assert.match(answer,/Gross Margin: Technology Products leads/);
  assert.match(answer,/Page 4/);assert.doesNotMatch(answer,/Page 1/);
  const unverified={...doc,chunks:[text.replace(/^Page [12]$/gm,'')]};
  assert.doesNotMatch(answerPdfLocally(unverified,'explain division performance'),/\[Page/);
  const missing={...doc,chunks:['Page 1\nBusiness overview\nThere is no segment table in this report.']};
  assert.match(answerPdfLocally(missing,'explain abt division performance'),/does not contain an aligned division table/);
  assert.match(answerPdfLocally(doc,'compare division performance on page 2'),/does not contain.*on page 2/);
});

test('provider authentication, limits, availability and timeout retain accurate safe diagnostics',()=>{
  for(const [status,message] of [[401,/authentication failed/],[429,/rate-limited/],[503,/temporarily unavailable/],[504,/timed out/]]){
    for(const error of [{status},{message:JSON.stringify({error:{code:status,message:'Test error'}})},{response:{status,data:{error:{code:status,message:'Test error'}}}}]){
      assert.equal(getHttpStatus(error),status);assert.match(userFacingGeminiError(error),message);
      assert.equal(isDailyGeminiQuotaError(error),false);assert.doesNotMatch(userFacingGeminiError(error),/daily|quota.*exhausted/);
    }
  }
  assert.equal(getHttpStatus({name:'RequestTimeoutError'}),504);
  assert.equal(isDailyGeminiQuotaError({status:429,message:JSON.stringify({error:{code:429,message:'Quota exceeded, requests per minute'}})}),false);
  assert.equal(isDailyGeminiQuotaError({status:429,message:JSON.stringify({error:{code:429,message:'Daily quota exceeded'}})}),true);
  assert.equal(isDailyGeminiQuotaError({status:429,appBudgetExceeded:true}),false);
  assert.doesNotMatch(userFacingGeminiError({status:401,message:'secret-key-value'}),/secret-key-value/);
});

test('division table profits, missing values and equal results remain grounded',()=>{
  const source={kind:'pdf',pageCount:7,chunks:['Page 7\nDivision Performance\nDivision Revenue Net Profit Gross Margin\nAlpha $1,200 $120 10%\nBeta $1,200 - 20%\nGamma $900 $90 10%']};
  const answer=answerPdfLocally(source,'pls explain abt division performance');
  assert.match(answer,/Alpha: Revenue: \$1,200; Net Profit: \$120/);
  assert.match(answer,/Beta: Revenue: \$1,200; Net Profit: -/);
  assert.match(answer,/Revenue: Alpha, Beta leads/);
  assert.match(answer,/Net Profit: Alpha leads; Gamma/);
  assert.match(answer,/Calculated Net Profit gap.*30.*Page 7/);
  assert.doesNotMatch(answer,/Page [1-6]|Missing division metrics/);
});

test('division comparison never substitutes another reporting quarter',()=>{
  assert.match(answerPdfLocally(doc,'explain division performance for Q1'),/does not contain.*for Q1/);
  assert.doesNotMatch(answerPdfLocally(doc,'compare Q1 and Q2 division performance'),/Technology Products:/);
  assert.match(answerPdfLocally(doc,'explain division performance for Q2'),/Technology Products:/);
});
