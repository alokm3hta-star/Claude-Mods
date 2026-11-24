// Words the on-device model may tag as a name or company but which are product,
// platform or technology names. A model span is left unmasked only when every
// word of it is here (or in your list's "keep", "keepAsIs" or "model.allow"), so
// "Priya HANA" is still masked. Apart from the wiki agent names below (an owner decision), keep it
// to products and plain technical words, and nothing under three letters (initials). Compared in lower case.
export const ALLOW_VOCAB: readonly string[] = [
  // SAP products, platforms and tools
  'sap', 'hana', 's/4hana', 's4hana', '4hana', 'bw/4hana', 'bw4hana', 'ecc', 'erp', 'crm', 'srm', 'scm', 'ewm', 'mdg', 'grc', 'iag',
  'btp', 'abap', 'adt', 'cds', 'rap', 'bopf', 'amdp', 'odata', 'rfc', 'bapi', 'idoc', 'badi', 'hdi', 'xsa', 'xsuaa', 'nse', 'pal', 'apl',
  'fiori', 'ui5', 'sapui5', 'openui5', 'joule', 'ariba', 'concur', 'fieldglass', 'successfactors', 'signavio', 'leanix', 'datasphere',
  'hybris', 'gigya', 'qualtrics', 'emarsys', 'sac', 'bpc', 'cpi', 'apim', 'aif', 'alm', 'solman', 'charm', 'cts',
  'tms', 'gcts', 'abapgit', 'kyma', 'cap', 'mta', 'mbt', 'cloudfoundry', 'rise', 'grow', 'teched', 'sapphire', 'launchpad',
  'workzone', 'ias', 'ips', 'cis', 'trm', 'pscd', 'ilm', 'hcm', 'fscm',
  // plain technical words that appear in product names
  'cloud', 'analytics', 'business', 'technology', 'platform', 'integration', 'suite', 'event', 'mesh', 'mission', 'control',
  'center', 'centre', 'work', 'zone', 'build', 'apps', 'process', 'automation', 'workflow', 'identity', 'authentication',
  'provisioning', 'connectivity', 'destination', 'service', 'services', 'connector', 'gateway', 'data', 'intelligence',
  'warehouse', 'planning', 'embedded', 'live', 'connection', 'public', 'private', 'edition', 'premium', 'base', 'generative',
  'core', 'hub', 'agent', 'agents', 'studio', 'clean', 'extension', 'adapter', 'adapters', 'api', 'apis', 'portal',
  'management', 'master', 'governance', 'application', 'applications', 'runtime', 'environment', 'transport', 'system',
  'landscape', 'model', 'models', 'engine', 'server', 'client', 'library', 'framework', 'console', 'dashboard', 'kernel',
  // The LLM Wiki's agent names, allowed on the owner's decision (2026-11-24) so
  // project instructions and @-commands stay readable. The model then leaves a
  // real person of the same first name unmasked; your list still masks anyone on it.
  'alex', 'aaron', 'adrian', 'anja', 'sarah', 'dana', 'kylie',
  // other vendors and tools
  'microsoft', 'azure', 'aws', 'amazon', 'google', 'gcp', 'ibm', 'oracle', 'salesforce', 'servicenow', 'workday', 'snowflake',
  'databricks', 'anthropic',
  // test, release and operations tools (2026-11-24: masked as names in a tooling document)
  'xray', 'tosca', 'tricentis', 'neoload', 'loadrunner', 'puppet', 'ansible', 'selenium', 'cypress', 'playwright',
  'postman', 'testrail', 'zephyr', 'qtest', 'sonarqube', 'dynatrace', 'appdynamics', 'splunk', 'grafana', 'citrix',
  'vdi', 'jmeter', 'gatling', 'katalon', 'worksoft', 'opentext', 'qtp', 'uft', 'openai', 'github', 'gitlab', 'bitbucket', 'jira', 'confluence', 'slack', 'teams', 'sharepoint',
  'outlook', 'excel', 'powerbi', 'tableau', 'anaplan', 'kafka', 'kubernetes', 'docker', 'terraform', 'jenkins', 'python',
  'java', 'javascript', 'typescript', 'node', 'react', 'langchain', 'langgraph', 'langfuse', 'arize', 'mcp', 'llm', 'json',
  'yaml', 'xml', 'csv', 'sql', 'http', 'https', 'rest', 'soap', 'oauth', 'saml', 'jwt', 'ldap', 'scim', 'edi', 'sftp',
]

// Public documentation sites whose addresses the model may leave unmasked, so
// sources can be cited. An address is kept only as a whole, only when its host
// is one of these or ends in "." and one of these, and never when it names a
// person (see model.ts, publicUrl). Vendor documentation and help sites only:
// no tenant domains (such as a company's own atlassian.net or sharepoint.com).
export const ALLOW_DOMAINS: readonly string[] = [
  'sap.com', 'tricentis.com', 'getxray.app', 'atlassian.com', 'microsoft.com', 'aws.amazon.com', 'cloud.google.com',
  'ibm.com', 'oracle.com', 'servicenow.com', 'salesforce.com', 'puppet.com', 'ansible.com', 'redhat.com',
  'selenium.dev', 'cypress.io', 'playwright.dev', 'postman.com', 'sonarsource.com', 'dynatrace.com', 'splunk.com',
  'grafana.com', 'citrix.com', 'apache.org', 'python.org', 'nodejs.org', 'mozilla.org', 'w3.org', 'ietf.org',
  'iso.org', 'anthropic.com', 'claude.com', 'wikipedia.org', 'gov.uk', 'ncsc.gov.uk', 'ico.org.uk',
]
