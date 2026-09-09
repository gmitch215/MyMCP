export interface EvalCase {
	/** the description to generate tools from, relative to the repo root */
	spec: string;
	prompt: string;
	/** the tool a competent model should reach for */
	expectTool: string;
	/** arguments that must be present, with the value they should carry */
	expectArgs?: Record<string, unknown>;
	/** arguments that must be present, value unchecked */
	requireArgs?: string[];
}

/**
 * These measure whether the generated tool names, descriptions and schemas are usable by a model,
 * which is a property no unit test can assert. A schema can be perfectly well formed and still
 * leave a model unable to tell two operations apart.
 */
export const CASES: EvalCase[] = [
	{
		spec: 'docker/specs/petstore.json',
		prompt: 'Find all the pets that are currently available.',
		expectTool: 'findPetsByStatus',
		expectArgs: { status: 'available' }
	},
	{
		spec: 'docker/specs/petstore.json',
		prompt: 'Look up the pet with ID 42.',
		expectTool: 'getPetById',
		expectArgs: { petId: 42 }
	},
	{
		spec: 'docker/specs/petstore.json',
		prompt: 'Delete the order with ID 7 from the store.',
		expectTool: 'deleteOrder',
		expectArgs: { orderId: 7 }
	},
	{
		spec: 'docker/specs/petstore.json',
		prompt: 'How many pets are in the inventory, grouped by status?',
		expectTool: 'getInventory'
	},
	{
		spec: 'docker/specs/petstore.json',
		prompt: 'Log in as user "octocat" with password "hunter2".',
		expectTool: 'loginUser',
		requireArgs: ['username', 'password']
	},
	{
		spec: 'docker/specs/petstore.json',
		prompt: 'Find the pets tagged "friendly" and "small".',
		expectTool: 'findPetsByTags',
		requireArgs: ['tags']
	},
	{
		spec: 'docker/specs/petstore.json',
		prompt: 'Place a new order for pet 12, quantity 2.',
		expectTool: 'placeOrder',
		requireArgs: ['body']
	},
	{
		spec: 'docker/specs/echo.json',
		prompt: 'Send a GET request to the "widgets" path and trace it with the ID "abc-123".',
		expectTool: 'echoGet',
		expectArgs: { segment: 'widgets', 'X-Trace': 'abc-123' }
	},
	{
		spec: 'docker/specs/echo.json',
		prompt: 'Fetch the endpoint that returns a gzip-compressed response.',
		expectTool: 'gzipped'
	},
	{
		spec: 'docker/specs/echo.json',
		prompt: 'Call the endpoint that needs a bearer token.',
		expectTool: 'needsBearer'
	}
];

/** the share of cases that must pass for the lane to be considered green */
export const PASS_THRESHOLD = 0.8;
