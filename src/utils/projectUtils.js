export function extractProject(issueKey) {
    console.log('[DEBUG] extractProject called with:', issueKey);
    if (!issueKey || typeof issueKey !== "string") {
        return null;
    }

    //Match patern :
    const match = issueKey.match(/^([A-Z][A-Z0-9]+)-/i);
    const projectKey = match ? match[1].toUpperCase() : null;
    console.log('[DEBUG] extractProject returns:', projectKey);
    return projectKey;
}

export async function findOrCreateProject(projectKey,userEmail){
const Project = await import('../models/Project.js').then(mod => mod.default);
if(!projectKey) {
    throw new Error("Project key is required");
}

//Normalize to uppercase
const normalizedKey = projectKey.toUpperCase();

let project = await Project.findOne({projectKey:normalizedKey});
if(!project){
    project = new Project({
        projectKey:normalizedKey,
        createdBy:userEmail,
        firstGeneratedAt:new Date(),
        lastGeneratedAt:new Date(),
        totalGenerations:0
    });
    await project.save();
}else{
    //Update last generation date
    project.lastGeneratedAt = new Date();
    project.totalGenerations += 1;
    await project.save();
}
return project;
}