import {Connection} from "../connection/Connection";
import {EntityMetadata} from "../metadata/EntityMetadata";
import {QueryBuilder} from "../query-builder/QueryBuilder";
import {PlainObjectToNewEntityTransformer} from "../query-builder/transformer/PlainObjectToNewEntityTransformer";
import {PlainObjectToDatabaseEntityTransformer} from "../query-builder/transformer/PlainObjectToDatabaseEntityTransformer";
import {EntityPersistOperationBuilder} from "../persistment/EntityPersistOperationsBuilder";
import {PersistOperationExecutor} from "../persistment/PersistOperationExecutor";
import {EntityWithId} from "../persistment/operation/PersistOperation";
import {FindOptions} from "../find-options/FindOptions";
import {FindOptionsUtils} from "../find-options/FindOptionsUtils";
import {ObjectLiteral} from "../common/ObjectLiteral";
import {QueryRunner} from "../query-runner/QueryRunner";
import {QueryRunnerProvider} from "../query-runner/QueryRunnerProvider";

/**
 * Repository is supposed to work with your entity objects. Find entities, insert, update, delete, etc.
 */
export class Repository<Entity extends ObjectLiteral> {

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(protected connection: Connection,
                protected metadata: EntityMetadata,
                protected queryRunnerProvider?: QueryRunnerProvider) {
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Returns object that is managed by this repository.
     * If this repository manages entity from schema, then it returns a name of that schema instead.
     */
    get target(): Function|string {
        return this.metadata.target;
    }

    /**
     * Checks if entity has an id.
     * If entity contains compose ids, then it checks them all.
     */
    hasId(entity: Entity): boolean {
        // if (this.metadata.parentEntityMetadata) {
        //     return this.metadata.parentEntityMetadata.parentIdColumns.every(parentIdColumn => {
        //         const columnName = parentIdColumn.propertyName;
        //         return !!entity &&
        //             entity.hasOwnProperty(columnName) &&
        //             entity[columnName] !== null &&
        //             entity[columnName] !== undefined &&
        //             entity[columnName] !== "";
        //     });

        // } else {
            return this.metadata.primaryColumns.every(primaryColumn => {
                const columnName = primaryColumn.propertyName;
                return !!entity &&
                    entity.hasOwnProperty(columnName) &&
                    entity[columnName] !== null &&
                    entity[columnName] !== undefined &&
                    entity[columnName] !== "";
            });
        // }
    }

    /**
     * Creates a new query builder that can be used to build a sql query.
     */
    createQueryBuilder(alias: string): QueryBuilder<Entity> {
        return new QueryBuilder(this.connection.driver, this.connection.entityMetadatas, this.connection.broadcaster/*, dbConnection*/) // todo: better to pass connection?
            .select(alias)
            .from(this.metadata.target, alias);
    }

    /**
     * Creates a new entity instance.
     */
    create(): Entity;

    /**
     * Creates a new entities and copies all entity properties from given objects into their new entities.
     * Note that it copies only properties that present in entity schema.
     */
    create(plainObjects: Object[]): Entity[];

    /**
     * Creates a new entity instance and copies all entity properties from this object into a new entity.
     * Note that it copies only properties that present in entity schema.
     */
    create(plainObject: Object): Entity;

    /**
     * Creates a new entity instance or instances.
     * Can copy properties from the given object into new entities.
     */
    create(plainObjectOrObjects?: Object|Object[]): Entity|Entity[] {
        if (plainObjectOrObjects instanceof Array)
            return plainObjectOrObjects.map(object => this.create(object as Object));

        const newEntity: Entity = this.metadata.create();
        if (plainObjectOrObjects) {
            const plainObjectToEntityTransformer = new PlainObjectToNewEntityTransformer();
            plainObjectToEntityTransformer.transform(newEntity, plainObjectOrObjects, this.metadata);
        }

        return newEntity;
    }

    /**
     * Creates a new entity from the given plan javascript object. If entity already exist in the database, then
     * it loads it (and everything related to it), replaces all values with the new ones from the given object
     * and returns this new entity. This new entity is actually a loaded from the db entity with all properties
     * replaced from the new object.
     */
    preload(object: Object): Promise<Entity> {
        const queryBuilder = this.createQueryBuilder(this.metadata.table.name);
        const plainObjectToDatabaseEntityTransformer = new PlainObjectToDatabaseEntityTransformer();
        return plainObjectToDatabaseEntityTransformer.transform(object, this.metadata, queryBuilder);
    }

    /**
     * Merges multiple entities (or entity-like objects) into a one new entity.
     */
    merge(...objects: ObjectLiteral[]): Entity {
        const newEntity: Entity = this.metadata.create();
        const plainObjectToEntityTransformer = new PlainObjectToNewEntityTransformer();
        objects.forEach(object => plainObjectToEntityTransformer.transform(newEntity, object, this.metadata));
        return newEntity;
    }

    /**
     * Persists (saves) all given entities in the database.
     * If entities do not exist in the database then inserts, otherwise updates.
     */
    async persist(entities: Entity[]): Promise<Entity[]>;

    /**
     * Persists (saves) a given entity in the database.
     * If entity does not exist in the database then inserts, otherwise updates.
     */
    async persist(entity: Entity): Promise<Entity>;

    /**
     * Persists one or many given entities.
     */
    async persist(entityOrEntities: Entity|Entity[]): Promise<Entity|Entity[]> {

        // if multiple entities given then go throw all of them and save them
        if (entityOrEntities instanceof Array)
            return Promise.all(entityOrEntities.map(entity => this.persist(entity)));

        const queryRunnerProvider = this.queryRunnerProvider || new QueryRunnerProvider(this.connection.driver);
        const queryRunner = await queryRunnerProvider.provide();
        try {
            const allPersistedEntities = await this.extractObjectsById(entityOrEntities, this.metadata);
            let loadedDbEntity: Entity|null = null;
            if (this.hasId(entityOrEntities)) {
                const queryBuilder = new QueryBuilder<Entity>(this.connection.driver, this.connection.entityMetadatas, this.connection.broadcaster, queryRunner) // todo: better to pass connection?
                    .select(this.metadata.table.name)
                    .from(this.metadata.target, this.metadata.table.name);
                const plainObjectToDatabaseEntityTransformer = new PlainObjectToDatabaseEntityTransformer();
                loadedDbEntity = await plainObjectToDatabaseEntityTransformer.transform(entityOrEntities, this.metadata, queryBuilder);
            }

            let entityWithIds: EntityWithId[] = [];
            if (loadedDbEntity)
                entityWithIds = await this.extractObjectsById(loadedDbEntity, this.metadata);

            // need to find db entities that were not loaded by initialize method
            const allDbEntities = await this.findNotLoadedIds(queryRunner, entityWithIds, allPersistedEntities);
            const persistedEntity = new EntityWithId(this.metadata, entityOrEntities);
            const dbEntity = new EntityWithId(this.metadata, loadedDbEntity!); // todo: find if this can be executed if loadedDbEntity is empty
            const entityPersistOperationBuilder = new EntityPersistOperationBuilder(this.connection.entityMetadatas);
            const persistOperation = entityPersistOperationBuilder.buildFullPersistment(this.metadata, dbEntity, persistedEntity, allDbEntities, allPersistedEntities);

            const persistOperationExecutor = new PersistOperationExecutor(this.connection.driver, this.connection.entityMetadatas, this.connection.broadcaster, queryRunner); // todo: better to pass connection?
            await persistOperationExecutor.executePersistOperation(persistOperation);
            return entityOrEntities;

        } finally {
            await queryRunnerProvider.release(queryRunner);
        }
    }

    /**
     * Removes a given entities from the database.
     */
    async remove(entities: Entity[]): Promise<Entity[]>;

    /**
     * Removes a given entity from the database.
     */
    async remove(entity: Entity): Promise<Entity>;

    /**
     * Removes one or many given entities.
     */
    async remove(entityOrEntities: Entity|Entity[]): Promise<Entity|Entity[]> {
        // if multiple entities given then go throw all of them and save them
        if (entityOrEntities instanceof Array) // todo: make it in transaction, like in persist
            return Promise.all(entityOrEntities.map(entity => this.remove(entity)));

        const queryRunnerProvider = this.queryRunnerProvider || new QueryRunnerProvider(this.connection.driver, true);
        const queryRunner = await queryRunnerProvider.provide();
        try {
            const queryBuilder = new QueryBuilder(this.connection.driver, this.connection.entityMetadatas, this.connection.broadcaster, queryRunner) // todo: better to pass connection?
                .select(this.metadata.table.name)
                .from(this.metadata.target, this.metadata.table.name);
            const plainObjectToDatabaseEntityTransformer = new PlainObjectToDatabaseEntityTransformer();
            const dbEntity = await plainObjectToDatabaseEntityTransformer.transform(entityOrEntities, this.metadata, queryBuilder);

            this.metadata.primaryColumnsWithParentPrimaryColumns.forEach(primaryColumn => entityOrEntities[primaryColumn.name] = undefined);
            const [dbEntities, allPersistedEntities] = await Promise.all([
                this.extractObjectsById(dbEntity, this.metadata),
                this.extractObjectsById(entityOrEntities, this.metadata)
            ]);
            const entityWithId = new EntityWithId(this.metadata, entityOrEntities);
            const dbEntityWithId = new EntityWithId(this.metadata, dbEntity);

            const entityPersistOperationBuilder = new EntityPersistOperationBuilder(this.connection.entityMetadatas);
            const persistOperation = entityPersistOperationBuilder.buildOnlyRemovement(this.metadata, dbEntityWithId, entityWithId, dbEntities, allPersistedEntities);
            const persistOperationExecutor = new PersistOperationExecutor(this.connection.driver, this.connection.entityMetadatas, this.connection.broadcaster, queryRunner); // todo: better to pass connection?
            await persistOperationExecutor.executePersistOperation(persistOperation);
            return entityOrEntities;

        } finally {
            await queryRunnerProvider.release(queryRunner);
        }
    }

    /**
     * Finds all entities.
     */
    async find(): Promise<Entity[]>;

    /**
     * Finds entities that match given conditions.
     */
    async find(conditions: Object): Promise<Entity[]>;

    /**
     * Finds entities with given find options.
     */
    async find(options: FindOptions): Promise<Entity[]>;

    /**
     * Finds entities that match given conditions and find options.
     */
    async find(conditions: Object, options: FindOptions): Promise<Entity[]>;

    /**
     * Finds entities that match given conditions and/or find options.
     */
    async find(conditionsOrFindOptions?: Object|FindOptions, options?: FindOptions): Promise<Entity[]> {
        return this.createFindQueryBuilder(conditionsOrFindOptions, options)
            .getResults();
    }

    /**
     * Finds entities that match given conditions.
     */
    async findAndCount(): Promise<[ Entity[], number ]>;

    /**
     * Finds entities that match given conditions.
     */
    async findAndCount(conditions: Object): Promise<[ Entity[], number ]>;

    /**
     * Finds entities that match given conditions.
     */
    async findAndCount(options: FindOptions): Promise<[ Entity[], number ]>;

    /**
     * Finds entities that match given conditions.
     */
    async findAndCount(conditions: Object, options: FindOptions): Promise<[ Entity[], number ]>;

    /**
     * Finds entities that match given conditions.
     */
    async findAndCount(conditionsOrFindOptions?: Object|FindOptions, options?: FindOptions): Promise<[ Entity[], number ]> {
        return this.createFindQueryBuilder(conditionsOrFindOptions, options)
            .getResultsAndCount();
    }

    /**
     * Finds first entity that matches given conditions.
     */
    async findOne(): Promise<Entity>;

    /**
     * Finds first entity that matches given conditions.
     */
    async findOne(conditions: Object): Promise<Entity>;

    /**
     * Finds first entity that matches given find options.
     */
    async findOne(options: FindOptions): Promise<Entity>;

    /**
     * Finds first entity that matches given conditions and find options.
     */
    async findOne(conditions: Object, options: FindOptions): Promise<Entity>;

    /**
     * Finds first entity that matches given conditions and/or find options.
     */
    async findOne(conditionsOrFindOptions?: Object|FindOptions, options?: FindOptions): Promise<Entity> {
        return this.createFindQueryBuilder(conditionsOrFindOptions, options)
            .getSingleResult();
    }

    /**
     * Finds entity with given id.
     */
    async findOneById(id: any, options?: FindOptions): Promise<Entity> {
        const conditions: ObjectLiteral = {};
        if (this.metadata.hasMultiplePrimaryKeys) {
            this.metadata.primaryColumns.forEach(primaryColumn => {
                conditions[primaryColumn.name] = id[primaryColumn.name];
            });
            this.metadata.parentIdColumns.forEach(primaryColumn => {
                conditions[primaryColumn.name] = id[primaryColumn.propertyName];
            });
        } else {
            if (this.metadata.primaryColumns.length > 0) {
                conditions[this.metadata.firstPrimaryColumn.name] = id;
            } else if (this.metadata.parentIdColumns.length > 0) {
                conditions[this.metadata.parentIdColumns[0].name] = id;
            }
        }
        return this.createFindQueryBuilder(conditions, options)
            .getSingleResult();
    }

    /**
     * Executes a raw SQL query and returns a raw database results.
     */
    async query(query: string): Promise<any> {
        const queryRunnerProvider = this.queryRunnerProvider || new QueryRunnerProvider(this.connection.driver);
        const queryRunner = await queryRunnerProvider.provide();
        try {
            return queryRunner.query(query);

        } finally {
            await queryRunnerProvider.release(queryRunner);
        }
    }

    /**
     * Wraps given function execution (and all operations made there) in a transaction.
     * All database operations must be executed using provided repository.
     */
    async transaction(runInTransaction: (repository: Repository<Entity>) => Promise<any>|any): Promise<any> {
        const queryRunnerProvider = this.queryRunnerProvider || new QueryRunnerProvider(this.connection.driver, true);
        const queryRunner = await queryRunnerProvider.provide();
        const transactionRepository = new Repository<Entity>(this.connection, this.metadata, queryRunnerProvider);

        try {
            await queryRunner.beginTransaction();
            const result = await runInTransaction(transactionRepository);
            await queryRunner.commitTransaction();
            return result;

        } catch (err) {
            await queryRunner.rollbackTransaction();
            throw err;

        } finally {
            await queryRunnerProvider.release(queryRunner);
            if (!this.queryRunnerProvider) // if we used a new query runner provider then release it
                await queryRunnerProvider.releaseReused();
        }
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    protected createFindQueryBuilder(conditionsOrFindOptions?: Object|FindOptions, options?: FindOptions) {
        const findOptions = FindOptionsUtils.isFindOptions(conditionsOrFindOptions) ? conditionsOrFindOptions : <FindOptions> options;
        const conditions = FindOptionsUtils.isFindOptions(conditionsOrFindOptions) ? undefined : conditionsOrFindOptions;

        const alias = findOptions ? findOptions.alias : this.metadata.table.name;
        const qb = this.createQueryBuilder(alias);
        if (findOptions) {
            FindOptionsUtils.applyOptionsToQueryBuilder(qb, findOptions);
        }
        if (conditions) {
            Object.keys(conditions).forEach(key => {
                const name = key.indexOf(".") === -1 ? alias + "." + key : key;
                qb.andWhere(name + "=:" + key);
            });
            qb.addParameters(conditions);
        }
        return qb;
    }

    /**
     * When ORM loads dbEntity it uses joins to load all entity dependencies. However when dbEntity is newly persisted
     * to the db, but uses already exist in the db relational entities, those entities cannot be loaded, and will
     * absent in dbEntities. To fix it, we need to go throw all persistedEntities we have, find out those which have
     * ids, check if we did not load them yet and try to load them. This algorithm will make sure that all dbEntities
     * are loaded. Further it will help insert operations to work correctly.
     */
    protected findNotLoadedIds(queryRunner: QueryRunner, dbEntities: EntityWithId[], persistedEntities: EntityWithId[]): Promise<EntityWithId[]> {
        const missingDbEntitiesLoad = persistedEntities
            .filter(entityWithId => entityWithId.id !== null && entityWithId.id !== undefined) // todo: not sure if this condition will work
            .filter(entityWithId => !dbEntities.find(dbEntity => dbEntity.entityTarget === entityWithId.entityTarget && dbEntity.compareId(entityWithId.id!)))
            .map(entityWithId => {
                const metadata = this.connection.entityMetadatas.findByTarget(entityWithId.entityTarget);
                const alias = (entityWithId.entityTarget as any).name;
                const qb = new QueryBuilder(this.connection.driver, this.connection.entityMetadatas, this.connection.broadcaster, queryRunner)
                    .select(alias)
                    .from(entityWithId.entityTarget, alias);

                const parameters: ObjectLiteral = {};
                let condition = "";

                if (this.metadata.hasParentIdColumn) {
                    condition = this.metadata.parentIdColumns.map(parentIdColumn => {
                        parameters[parentIdColumn.propertyName] = entityWithId.id![parentIdColumn.propertyName];
                        return alias + "." + parentIdColumn.propertyName + "=:" + parentIdColumn.propertyName;
                    }).join(" AND ");
                } else {
                    condition = this.metadata.primaryColumns.map(primaryColumn => {
                        parameters[primaryColumn.propertyName] = entityWithId.id![primaryColumn.propertyName];
                        return alias + "." + primaryColumn.propertyName + "=:" + primaryColumn.propertyName;
                    }).join(" AND ");
                }

                const qbResult = qb.where(condition, parameters).getSingleResult();
                // const repository = this.connection.getRepository(entityWithId.entityTarget as any); // todo: fix type
                return qbResult.then(loadedEntity => {
                    if (!loadedEntity) return undefined;

                    return new EntityWithId(metadata, loadedEntity);
                });
            });

        return Promise.all<EntityWithId>(missingDbEntitiesLoad).then(missingDbEntities => {
            return dbEntities.concat(missingDbEntities.filter(dbEntity => !!dbEntity));
        });
    }

    /**
     * Extracts unique objects from given entity and all its downside relations.
     */
    protected extractObjectsById(entity: any, metadata: EntityMetadata, entityWithIds: EntityWithId[] = []): Promise<EntityWithId[]> { // todo: why promises used there?
        const promises = metadata.relations.map(relation => {
            const relMetadata = relation.inverseEntityMetadata;

            const value = relation.isLazy ? entity["__" + relation.propertyName + "__"] : entity[relation.propertyName];
            if (!value)
                return undefined;
            
            if (value instanceof Array) {
                const subPromises = value.map((subEntity: any) => {
                    return this.extractObjectsById(subEntity, relMetadata, entityWithIds);
                });
                return Promise.all(subPromises);
                
            } else {
                return this.extractObjectsById(value, relMetadata, entityWithIds);
            }
        });
        
        return Promise.all<any>(promises.filter(result => !!result)).then(() => {
            if (!entityWithIds.find(entityWithId => entityWithId.entity === entity)) {
                const entityWithId = new EntityWithId(metadata, entity);
                entityWithIds.push(entityWithId);
            }

            return entityWithIds;
        });
    }

}