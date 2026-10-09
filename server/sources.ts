export type Provider = 'TalentNet' | 'Magnit' | 'KellyOCG' | 'Randstad' | 'LiveHire' | 'Raise' | 'Staffing Future' | 'Matador';
export interface SourceConfig {
  id: string;
  company: string;
  provider: Provider;
  url: string;
  country: string;
  domain?: string;
  contractOnly: boolean;
}
const source = (id: string, company: string, provider: Provider, url: string, country = 'US', domain?: string, contractOnly = true): SourceConfig => ({ id, company, provider, url, country, domain, contractOnly });
export const SOURCES: SourceConfig[] = [
  source('meta','Meta','TalentNet','https://us.meta.talentnet.community/jobs/search'),
  source('microsoft','Microsoft','TalentNet','https://us.microsoft.talentnet.community/jobs/search'),
  source('airbnb','Airbnb','TalentNet','https://magnit-airbnb.talentnet.community/jobs/search'),
  source('boeing','Boeing','TalentNet','https://boeing.talentnet.community/jobs/search'),
  source('wellsfargo','Wells Fargo','TalentNet','https://wellsfargo.talentnet.community/jobs/search'),
  source('kpmg','KPMG','TalentNet','https://us.kpmg.talentnet.community/jobs/search'),
  source('pnc','PNC','TalentNet','https://pnc.talentnet.community/jobs/search'),
  ...[
    ['pinterest','Pinterest'],['coinbase','Coinbase'],['servicenow','ServiceNow'],
    ['thecignagroup','The Cigna Group'],['novartis','Novartis'],['diageo','Diageo'],
    ['universalmusicgroup','Universal Music Group'],['boehringer-ingelheim','Boehringer Ingelheim'],
    ['blackveatch','Black & Veatch'],['raymondjames','Raymond James'],['mufg','MUFG'],
    ['consumers-energy','Consumers Energy'],['cnb','City National Bank'],['connectiverx','ConnectiveRx'],
    ['guidewell','GuideWell'],['bpm','Blueprint Medicines'],['keysight','Keysight Technologies'],
    ['onebrooklynhealth','One Brooklyn Health'],
  ].map(([id, company]) => source(id,company,'Magnit',`https://directsource.magnitglobal.com/us/${id}/jobs`)),
  source('apple','Apple','Magnit','https://applecontingentworkforce.willhire.co/jobs'),
  source('applemarcom','Apple Marcom','Magnit','https://applemarcom.willhire.co/jobs'),
  ...[['comau','Comau'],['corning','Corning'],['toyota','Toyota'],['workday','Workday']].map(([id, company]) => source(id,company,'Magnit',`https://${id}.willhire.co/jobs`)),
  source('vattenfall','Vattenfall','Magnit','https://vattenfall.eu.willhire.co/jobs','Europe'),
  source('jnj','Johnson & Johnson','KellyOCG','https://jnj.toptalents.com/','US','jnj'),
  source('astrazeneca','AstraZeneca','KellyOCG','https://astrazeneca.toptalents.com/','Global','astrazeneca'),
  source('farmers','Farmers Insurance','KellyOCG','https://farmers.toptalents.com/','US','farmers'),
  source('johndeere','John Deere','KellyOCG','https://johndeere.toptalents.com/','US','johndeere'),
  source('iqvia','IQVIA','KellyOCG','https://www.toptalents.com/iqvia','Global'),
  source('leonardo','Leonardo','KellyOCG','https://www.toptalents.com/leonardo','UK'),
  source('tel','Tokyo Electron','KellyOCG','https://www.toptalents.com/tel'),
  source('solidigm','Solidigm','KellyOCG','https://solidigm.toptalents.com/en','US','solidigm'),
  source('owenscorning','Owens Corning','KellyOCG','https://owenscorning.toptalents.com/','US','owenscorning'),
  source('avanos','Avanos','KellyOCG','https://avanos.toptalents.com/','US','avanos'),
  source('kellyocg','KellyOCG','KellyOCG','https://talentcontractcommunity.kellyservices.com/','Global'),
  source('barclays','Barclays','Randstad','https://barclays.talent-community.com/','UK'),
  source('tescobank','Tesco Bank','Randstad','https://barclays.talent-community.com/tesco-bank','UK'),
  source('fidelityinternational','Fidelity International','Randstad','https://fidelityinternational.talent-community.com/','Global'),
  source('thales','Thales','Randstad','https://thales.talent-community.com/','UK'),
  source('booking','Booking.com','Randstad','https://booking.talent-community.com/','Europe'),
  source('nestle','Nestlé','Randstad','https://nestle.talent-community.com/','Global'),
  source('aviva','Aviva','Randstad','https://aviva.talent-community.com/contractor-roles','UK'),
  source('lonza','Lonza','Randstad','https://lonza.talent-community.com/','Global',undefined,false),
  source('enbridge','Enbridge','Raise','https://enbridge.raise.jobs/','North America'),
  source('epiq','Epiq','Raise','https://epiqcontingent.jobs/'),
  source('applied','Applied Materials','Raise','https://appliedcontract.jobs/'),
  source('lyft','Lyft','Raise','https://raise.jobs/lyft/'),
  source('inspyr','INSPYR Solutions','Staffing Future','https://www.inspyrsolutions.com/job-search/','US',undefined,false),
  source('tundra','Tundra Technical Solutions','Matador','https://community.tundratechnical.ca/jobs/','Global',undefined,false),
];

// Archived after repeated access restrictions; retained only in historical records.
export const RETIRED_SOURCE_IDS = ['adm','abbott','halliburton','nikeinc'];
